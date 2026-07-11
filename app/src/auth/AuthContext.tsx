import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import sodium from "react-native-libsodium";

import * as api from "../api/client";
import { prepareAvatarForUpload, uploadAvatarToS3 } from "../api/avatarUpload";
import { ApiError } from "../api/client";
import { getOrCreateIdentity } from "../crypto/identity";
import { initDatabase, wipeAccountDatabase } from "../db/database";
import { connectSocket, disconnectSocket } from "../network/socket";
import {
  clearDeviceId,
  clearIdentityKeys,
  getDeviceName,
  getOrCreateDeviceId,
  saveDeviceId,
} from "../storage/secureKeyStore";
import { clearProfile, loadProfile, savePhoneNumber, saveProfile, type Profile } from "../storage/profileStore";
import {
  clearSessionEmail,
  clearSessionToken,
  loadSessionEmail,
  loadSessionToken,
  saveSessionEmail,
  saveSessionToken,
} from "../storage/sessionStore";

type AuthStatus = "loading" | "signed-out" | "needs-profile" | "signed-in";

interface AuthContextValue {
  status: AuthStatus;
  email: string | null;
  profile: Profile | null;
  token: string | null;
  requestOtp: (email: string) => Promise<void>;
  verifyOtp: (email: string, code: string) => Promise<void>;
  devLogin: (email: string) => Promise<void>;
  completeProfile: (fullName: string, photoUri: string | null) => Promise<void>;
  updateProfile: (fullName: string, photoUri: string | null) => Promise<void>;
  updatePhoneNumber: (phoneNumber: string | null) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Other users need to see this profile, so it's pushed to the server too;
// failures here are swallowed so a flaky connection can't block onboarding
// or local profile edits (the local copy is what this device relies on).
// photoChanged tells us whether photoUri is a newly-picked photo (needing a
// fresh S3 upload) or just carried over unchanged from a name-only edit —
// without it, every save would re-upload and delete-replace the same photo.
async function pushRemoteProfile(
  token: string,
  fullName: string,
  photoUri: string | null,
  photoChanged: boolean
): Promise<void> {
  try {
    if (!photoChanged) {
      await api.updateRemoteProfile(token, fullName);
      return;
    }

    if (!photoUri) {
      await api.updateRemoteProfile(token, fullName, null);
      return;
    }

    const preparedUri = await prepareAvatarForUpload(photoUri);
    const target = await api.requestAvatarUploadUrl(token);
    await uploadAvatarToS3(target, preparedUri);
    await api.updateRemoteProfile(token, fullName, target.key);
  } catch (err) {
    console.warn("[profile] failed to sync profile to server", err);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Tracks the signed-in email outside of React state so signOutLocally
  // (memoized once, below) always clears the profile for whichever account
  // is actually active rather than a stale value captured at mount.
  const emailRef = useRef<string | null>(null);
  useEffect(() => {
    emailRef.current = email;
  }, [email]);

  // Called both on explicit logout and when the server tells this device
  // it's been superseded by a login elsewhere (see "session:revoked" below).
  const signOutLocally = useCallback(() => {
    disconnectSocket();
    void clearSessionToken();
    void clearSessionEmail();
    if (emailRef.current) void clearProfile(emailRef.current);
    setEmail(null);
    setProfile(null);
    setToken(null);
    setStatus("signed-out");
  }, []);

  useEffect(() => {
    (async () => {
      const storedToken = await loadSessionToken();
      if (!storedToken) {
        setStatus("signed-out");
        return;
      }

      const cachedEmail = await loadSessionEmail();

      try {
        const session = await api.getSession(storedToken);
        await saveSessionEmail(session.email);
        // Opens this account's own local database/profile/identity so a
        // device that was previously signed into a different account
        // doesn't surface that account's chats, profile, or crypto keys here.
        initDatabase(session.email);
        await getOrCreateIdentity(session.email);
        const localProfile = await loadProfile(session.email);
        setEmail(session.email);
        setToken(storedToken);
        connectSocket(storedToken).on("session:revoked", signOutLocally);
        setProfile(localProfile);
        setStatus(localProfile ? "signed-in" : "needs-profile");
      } catch (err) {
        // A 401 means the server explicitly rejected this token (expired,
        // revoked by a login elsewhere, etc.) — that's a real sign-out.
        // Anything else (network error, Render cold start, timeout) just
        // means we couldn't confirm the session right now; trust the local
        // token instead of forcing a re-login over a transient hiccup.
        if (err instanceof ApiError && err.status === 401) {
          signOutLocally();
          return;
        }

        if (!cachedEmail) {
          signOutLocally();
          return;
        }

        initDatabase(cachedEmail);
        await getOrCreateIdentity(cachedEmail);
        const localProfile = await loadProfile(cachedEmail);
        setEmail(cachedEmail);
        setToken(storedToken);
        connectSocket(storedToken).on("session:revoked", signOutLocally);
        setProfile(localProfile);
        setStatus(localProfile ? "signed-in" : "needs-profile");
      }
    })();
  }, [signOutLocally]);

  const requestOtp = useCallback(async (emailAddress: string) => {
    await api.requestOtp(emailAddress);
  }, []);

  // Shared tail for anything that ends with "here's a fresh session token" —
  // real OTP verification and the SKIP_OTP dev bypass both land here.
  const establishSession = useCallback(
    async (emailAddress: string, newToken: string) => {
      initDatabase(emailAddress);
      await saveSessionToken(newToken);
      await saveSessionEmail(emailAddress);
      setEmail(emailAddress);
      setToken(newToken);
      connectSocket(newToken).on("session:revoked", signOutLocally);

      const localProfile = await loadProfile(emailAddress);
      if (localProfile) {
        setProfile(localProfile);
        setStatus("signed-in");
      } else {
        setStatus("needs-profile");
      }
    },
    [signOutLocally]
  );

  const verifyOtp = useCallback(
    async (emailAddress: string, code: string) => {
      const identity = await getOrCreateIdentity(emailAddress);
      await sodium.ready;
      const publicKey = sodium.to_base64(identity.publicKey);
      // Persisted per-account (see secureKeyStore) so re-authenticating from
      // this same device later reuses this same device registration instead
      // of the server treating it as a brand new linked device.
      const deviceId = await getOrCreateDeviceId(emailAddress);

      const { token: newToken, deviceId: linkedDeviceId } = await api.verifyOtp(
        emailAddress,
        code,
        publicKey,
        deviceId,
        getDeviceName()
      );
      await saveDeviceId(emailAddress, linkedDeviceId);
      await establishSession(emailAddress, newToken);
    },
    [establishSession]
  );

  // Dev-only: see EmailEntryScreen for the EXPO_PUBLIC_SKIP_OTP toggle. Only
  // succeeds if the server also has SKIP_OTP=true.
  const devLogin = useCallback(
    async (emailAddress: string) => {
      const identity = await getOrCreateIdentity(emailAddress);
      await sodium.ready;
      const publicKey = sodium.to_base64(identity.publicKey);
      const deviceId = await getOrCreateDeviceId(emailAddress);

      const { token: newToken, deviceId: linkedDeviceId } = await api.devLogin(
        emailAddress,
        publicKey,
        deviceId,
        getDeviceName()
      );
      await saveDeviceId(emailAddress, linkedDeviceId);
      await establishSession(emailAddress, newToken);
    },
    [establishSession]
  );

  const completeProfile = useCallback(
    async (fullName: string, photoUri: string | null) => {
      if (!email) throw new Error("completeProfile called while signed out");
      const saved = await saveProfile(email, fullName, photoUri);
      setProfile(saved);
      setStatus("signed-in");
      // Onboarding: never previously synced, so always treat the photo (if any) as new.
      if (token) await pushRemoteProfile(token, fullName, photoUri, true);
    },
    [email, token]
  );

  const updateProfile = useCallback(
    async (fullName: string, photoUri: string | null) => {
      if (!email) throw new Error("updateProfile called while signed out");
      // Captured before saveProfile overwrites local `profile` state, so this
      // reflects whether the user actually picked a new photo this edit.
      const photoChanged = photoUri !== profile?.photoUri;
      const saved = await saveProfile(email, fullName, photoUri);
      setProfile(saved);
      if (token) await pushRemoteProfile(token, fullName, photoUri, photoChanged);
    },
    [email, token, profile]
  );

  // Unlike name/photo above, this can genuinely fail (number already linked
  // to another account) — the server call happens first and is left to
  // throw so the caller can surface that, instead of swallowing it and
  // leaving the local copy out of sync with what the server actually has.
  const updatePhoneNumber = useCallback(
    async (phoneNumber: string | null) => {
      if (!email || !token) throw new Error("updatePhoneNumber called while signed out");
      await api.updatePhoneNumber(token, phoneNumber);
      await savePhoneNumber(email, phoneNumber);
      setProfile((prev) => (prev ? { ...prev, phoneNumber } : prev));
    },
    [email, token]
  );

  const logout = useCallback(async () => {
    const currentToken = await loadSessionToken();
    if (currentToken) {
      await api.logout(currentToken).catch(() => {});
    }
    signOutLocally();
  }, [signOutLocally]);

  // Schedules server-side deletion (a 48-hour grace period during which
  // logging back in cancels it — see the server's accountDeletion module),
  // then wipes this account's local chat history and crypto identity right
  // away. Left to throw on failure so the caller can show an error instead
  // of signing the user out of an account that was never actually scheduled
  // for deletion.
  const deleteAccount = useCallback(async () => {
    if (!token || !email) throw new Error("deleteAccount called while signed out");
    await api.requestAccountDeletion(token);
    wipeAccountDatabase(email);
    await clearIdentityKeys(email);
    await clearDeviceId(email);
    signOutLocally();
  }, [token, email, signOutLocally]);

  const value = useMemo(
    () => ({
      status,
      email,
      profile,
      token,
      requestOtp,
      verifyOtp,
      devLogin,
      completeProfile,
      updateProfile,
      updatePhoneNumber,
      logout,
      deleteAccount,
    }),
    [
      status,
      email,
      profile,
      token,
      requestOtp,
      verifyOtp,
      devLogin,
      completeProfile,
      updateProfile,
      updatePhoneNumber,
      logout,
      deleteAccount,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

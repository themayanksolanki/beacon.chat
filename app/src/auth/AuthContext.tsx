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
import * as FileSystem from "expo-file-system/legacy";

import * as api from "../api/client";
import { ApiError } from "../api/client";
import { getOrCreateIdentity } from "../crypto/identity";
import { initDatabase, wipeAccountDatabase } from "../db/database";
import { connectSocket, disconnectSocket } from "../network/socket";
import { clearIdentityKeys } from "../storage/secureKeyStore";
import { clearProfile, loadProfile, saveProfile, type Profile } from "../storage/profileStore";
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
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// The picker/profileStore only deal in local file URIs; the server (and
// other users' apps) need the image inline, so it's base64-encoded here.
async function photoUriToDataUrl(photoUri: string): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(photoUri, { encoding: "base64" });
  return `data:image/jpeg;base64,${base64}`;
}

// Other users need to see this profile, so it's pushed to the server too;
// failures here are swallowed so a flaky connection can't block onboarding
// or local profile edits (the local copy is what this device relies on).
async function pushRemoteProfile(token: string, fullName: string, photoUri: string | null): Promise<void> {
  try {
    const avatarUrl = photoUri ? await photoUriToDataUrl(photoUri) : null;
    await api.updateRemoteProfile(token, fullName, avatarUrl);
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

      const { token: newToken } = await api.verifyOtp(emailAddress, code, publicKey);
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

      const { token: newToken } = await api.devLogin(emailAddress, publicKey);
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
      if (token) await pushRemoteProfile(token, fullName, photoUri);
    },
    [email, token]
  );

  const updateProfile = useCallback(
    async (fullName: string, photoUri: string | null) => {
      if (!email) throw new Error("updateProfile called while signed out");
      const saved = await saveProfile(email, fullName, photoUri);
      setProfile(saved);
      if (token) await pushRemoteProfile(token, fullName, photoUri);
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

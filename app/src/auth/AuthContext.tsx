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
import { clearProfile, isProfileSynced, loadProfile, markProfileSynced, saveProfile, type Profile } from "../storage/profileStore";
import {
  clearCachedIdentity,
  clearSessionToken,
  loadCachedIdentity,
  loadSessionToken,
  saveCachedIdentity,
  saveSessionToken,
  type CachedIdentity,
} from "../storage/sessionStore";

type AuthStatus = "loading" | "signed-out" | "needs-profile" | "signed-in";

interface AuthContextValue {
  status: AuthStatus;
  email: string | null;
  phoneNumber: string | null;
  profile: Profile | null;
  token: string | null;
  requestOtp: (email: string) => Promise<void>;
  verifyOtp: (email: string, code: string) => Promise<void>;
  requestPhoneOtp: (phoneNumber: string) => Promise<void>;
  verifyPhoneOtp: (phoneNumber: string, code: string) => Promise<void>;
  devLogin: (email: string) => Promise<void>;
  devLoginPhone: (phoneNumber: string) => Promise<void>;
  completeProfile: (fullName: string, photoUri: string | null) => Promise<void>;
  updateProfile: (fullName: string, photoUri: string | null) => Promise<void>;
  // Verified "add a missing login identifier" flow — see AccountScreen and
  // AddContactMethodScreen. Split into request/confirm since each is its own
  // OTP round trip; confirm* only resolves once the server has attached the
  // identifier to this account.
  requestAddEmailOtp: (email: string) => Promise<void>;
  confirmAddEmailOtp: (email: string, code: string) => Promise<void>;
  requestAddPhoneOtp: (phoneNumber: string) => Promise<void>;
  confirmAddPhoneOtp: (phoneNumber: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Other users need to see this profile, so it's pushed to the server too;
// failures here are swallowed so a flaky connection can't block onboarding
// or local profile edits (the local copy is what this device relies on).
// Returns whether it actually succeeded so the caller can persist that via
// markProfileSynced — a swallowed failure that's never retried is exactly
// what used to leave other users permanently seeing this account as
// "Unknown" even after accepting a contact request (see retrySyncIfNeeded).
// photoChanged tells us whether photoUri is a newly-picked photo (needing a
// fresh S3 upload) or just carried over unchanged from a name-only edit —
// without it, every save would re-upload and delete-replace the same photo.
async function pushRemoteProfile(
  token: string,
  fullName: string,
  photoUri: string | null,
  photoChanged: boolean
): Promise<boolean> {
  try {
    if (!photoChanged) {
      await api.updateRemoteProfile(token, fullName);
      return true;
    }

    if (!photoUri) {
      await api.updateRemoteProfile(token, fullName, null);
      return true;
    }

    const preparedUri = await prepareAvatarForUpload(photoUri);
    const target = await api.requestAvatarUploadUrl(token);
    await uploadAvatarToS3(target, preparedUri);
    await api.updateRemoteProfile(token, fullName, target.key);
    return true;
  } catch (err) {
    console.warn("[profile] failed to sync profile to server", err);
    return false;
  }
}

// Called whenever a session (re)establishes with a loaded local profile —
// cold start, and every fresh login. If the last save never actually made
// it to the server (see pushRemoteProfile), this retries it here instead of
// leaving it stuck until the user happens to edit their profile again.
// Fire-and-forget: shouldn't delay getting the signed-in UI up.
function retrySyncIfNeeded(accountKey: string, token: string, localProfile: Profile): void {
  void (async () => {
    if (await isProfileSynced(accountKey)) return;
    const succeeded = await pushRemoteProfile(token, localProfile.fullName, localProfile.photoUri, true);
    if (succeeded) await markProfileSynced(accountKey, true);
  })();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // The stable per-device key namespacing local chat DB/profile/identity
  // storage (see storage/accountKey.ts) — set once, the first time this
  // device establishes a session (whichever identifier was used to log in),
  // and never recomputed from email/phoneNumber afterwards. That matters
  // now that an account can have both identifiers: adding the second one
  // later must not change which local files this device already reads from.
  const accountKeyRef = useRef<string | null>(null);

  // Called both on explicit logout and when the server tells this device
  // it's been superseded by a login elsewhere (see "session:revoked" below).
  const signOutLocally = useCallback(() => {
    disconnectSocket();
    void clearSessionToken();
    void clearCachedIdentity();
    if (accountKeyRef.current) void clearProfile(accountKeyRef.current);
    accountKeyRef.current = null;
    setEmail(null);
    setPhoneNumber(null);
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

      const cached = await loadCachedIdentity();

      try {
        const session = await api.getSession(storedToken);
        const accountKey = cached?.accountKey ?? session.email ?? session.phoneNumber ?? session.userId;
        await saveCachedIdentity({ accountKey, email: session.email, phoneNumber: session.phoneNumber });
        // Opens this account's own local database/profile/identity so a
        // device that was previously signed into a different account
        // doesn't surface that account's chats, profile, or crypto keys here.
        initDatabase(accountKey);
        await getOrCreateIdentity(accountKey);
        const localProfile = await loadProfile(accountKey);
        accountKeyRef.current = accountKey;
        setEmail(session.email);
        setPhoneNumber(session.phoneNumber);
        setToken(storedToken);
        connectSocket(storedToken).on("session:revoked", signOutLocally);
        setProfile(localProfile);
        setStatus(localProfile ? "signed-in" : "needs-profile");
        if (localProfile) retrySyncIfNeeded(accountKey, storedToken, localProfile);
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

        if (!cached) {
          signOutLocally();
          return;
        }

        initDatabase(cached.accountKey);
        await getOrCreateIdentity(cached.accountKey);
        const localProfile = await loadProfile(cached.accountKey);
        accountKeyRef.current = cached.accountKey;
        setEmail(cached.email);
        setPhoneNumber(cached.phoneNumber);
        setToken(storedToken);
        connectSocket(storedToken).on("session:revoked", signOutLocally);
        setProfile(localProfile);
        setStatus(localProfile ? "signed-in" : "needs-profile");
        if (localProfile) retrySyncIfNeeded(cached.accountKey, storedToken, localProfile);
      }
    })();
  }, [signOutLocally]);

  const requestOtp = useCallback(async (emailAddress: string) => {
    await api.requestOtp(emailAddress);
  }, []);

  const requestPhoneOtp = useCallback(async (phone: string) => {
    await api.requestPhoneOtp(phone);
  }, []);

  // Shared tail for anything that ends with "here's a fresh session token" —
  // real OTP verification (email or phone) and the SKIP_OTP dev bypass all
  // land here. Exactly one of email/phoneNumber is set, matching whichever
  // identifier was just proven by OTP.
  const establishSession = useCallback(
    async (identity: { email?: string; phoneNumber?: string }, newToken: string) => {
      const accountKey = (identity.email ?? identity.phoneNumber)!;
      initDatabase(accountKey);
      await saveSessionToken(newToken);
      await saveCachedIdentity({
        accountKey,
        email: identity.email ?? null,
        phoneNumber: identity.phoneNumber ?? null,
      });
      accountKeyRef.current = accountKey;
      setEmail(identity.email ?? null);
      setPhoneNumber(identity.phoneNumber ?? null);
      setToken(newToken);
      connectSocket(newToken).on("session:revoked", signOutLocally);

      const localProfile = await loadProfile(accountKey);
      if (localProfile) {
        setProfile(localProfile);
        setStatus("signed-in");
        retrySyncIfNeeded(accountKey, newToken, localProfile);
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
      await establishSession({ email: emailAddress }, newToken);
    },
    [establishSession]
  );

  const verifyPhoneOtp = useCallback(
    async (phone: string, code: string) => {
      const identity = await getOrCreateIdentity(phone);
      await sodium.ready;
      const publicKey = sodium.to_base64(identity.publicKey);
      const deviceId = await getOrCreateDeviceId(phone);

      const { token: newToken, deviceId: linkedDeviceId } = await api.verifyPhoneOtp(
        phone,
        code,
        publicKey,
        deviceId,
        getDeviceName()
      );
      await saveDeviceId(phone, linkedDeviceId);
      await establishSession({ phoneNumber: phone }, newToken);
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
      await establishSession({ email: emailAddress }, newToken);
    },
    [establishSession]
  );

  // Phone counterpart of devLogin above — same SKIP_OTP dev bypass, just
  // keyed by phone number (see EmailEntryScreen's phone tab).
  const devLoginPhone = useCallback(
    async (phone: string) => {
      const identity = await getOrCreateIdentity(phone);
      await sodium.ready;
      const publicKey = sodium.to_base64(identity.publicKey);
      const deviceId = await getOrCreateDeviceId(phone);

      const { token: newToken, deviceId: linkedDeviceId } = await api.devLoginPhone(
        phone,
        publicKey,
        deviceId,
        getDeviceName()
      );
      await saveDeviceId(phone, linkedDeviceId);
      await establishSession({ phoneNumber: phone }, newToken);
    },
    [establishSession]
  );

  const completeProfile = useCallback(
    async (fullName: string, photoUri: string | null) => {
      const accountKey = accountKeyRef.current;
      if (!accountKey) throw new Error("completeProfile called while signed out");
      const saved = await saveProfile(accountKey, fullName, photoUri);
      setProfile(saved);
      setStatus("signed-in");
      // Onboarding: never previously synced, so always treat the photo (if any) as new.
      if (token && (await pushRemoteProfile(token, fullName, photoUri, true))) {
        await markProfileSynced(accountKey, true);
      }
    },
    [token]
  );

  const updateProfile = useCallback(
    async (fullName: string, photoUri: string | null) => {
      const accountKey = accountKeyRef.current;
      if (!accountKey) throw new Error("updateProfile called while signed out");
      // Captured before saveProfile overwrites local `profile` state, so this
      // reflects whether the user actually picked a new photo this edit.
      const photoChanged = photoUri !== profile?.photoUri;
      const saved = await saveProfile(accountKey, fullName, photoUri);
      setProfile(saved);
      if (token && (await pushRemoteProfile(token, fullName, photoUri, photoChanged))) {
        await markProfileSynced(accountKey, true);
      }
    },
    [token, profile]
  );

  // Persists a newly-added identifier into the cached identity blob (see
  // sessionStore) so a later cold start that can't reach the server (see the
  // startup effect's catch branch) still shows it, without ever touching
  // accountKey itself — that stays fixed for this device (see accountKeyRef).
  const persistIdentity = useCallback(
    async (next: { email: string | null; phoneNumber: string | null }) => {
      if (!accountKeyRef.current) return;
      await saveCachedIdentity({ accountKey: accountKeyRef.current, ...next });
    },
    []
  );

  const requestAddEmailOtp = useCallback(
    async (emailAddress: string) => {
      if (!token) throw new Error("requestAddEmailOtp called while signed out");
      await api.requestAddEmailOtp(token, emailAddress);
    },
    [token]
  );

  const confirmAddEmailOtp = useCallback(
    async (emailAddress: string, code: string) => {
      if (!token) throw new Error("confirmAddEmailOtp called while signed out");
      await api.verifyAddEmailOtp(token, emailAddress, code);
      const normalized = emailAddress.trim().toLowerCase();
      setEmail(normalized);
      await persistIdentity({ email: normalized, phoneNumber });
    },
    [token, phoneNumber, persistIdentity]
  );

  const requestAddPhoneOtp = useCallback(
    async (phone: string) => {
      if (!token) throw new Error("requestAddPhoneOtp called while signed out");
      await api.requestAddPhoneOtp(token, phone);
    },
    [token]
  );

  const confirmAddPhoneOtp = useCallback(
    async (phone: string, code: string) => {
      if (!token) throw new Error("confirmAddPhoneOtp called while signed out");
      await api.verifyAddPhoneOtp(token, phone, code);
      setPhoneNumber(phone);
      await persistIdentity({ email, phoneNumber: phone });
    },
    [token, email, persistIdentity]
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
    const accountKey = accountKeyRef.current;
    if (!token || !accountKey) throw new Error("deleteAccount called while signed out");
    await api.requestAccountDeletion(token);
    wipeAccountDatabase(accountKey);
    await clearIdentityKeys(accountKey);
    await clearDeviceId(accountKey);
    signOutLocally();
  }, [token, signOutLocally]);

  const value = useMemo(
    () => ({
      status,
      email,
      phoneNumber,
      profile,
      token,
      requestOtp,
      verifyOtp,
      requestPhoneOtp,
      verifyPhoneOtp,
      devLogin,
      devLoginPhone,
      completeProfile,
      updateProfile,
      requestAddEmailOtp,
      confirmAddEmailOtp,
      requestAddPhoneOtp,
      confirmAddPhoneOtp,
      logout,
      deleteAccount,
    }),
    [
      status,
      email,
      phoneNumber,
      profile,
      token,
      requestOtp,
      verifyOtp,
      requestPhoneOtp,
      verifyPhoneOtp,
      devLogin,
      devLoginPhone,
      completeProfile,
      updateProfile,
      requestAddEmailOtp,
      confirmAddEmailOtp,
      requestAddPhoneOtp,
      confirmAddPhoneOtp,
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

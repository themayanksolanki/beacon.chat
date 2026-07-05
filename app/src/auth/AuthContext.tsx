import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import sodium from "react-native-libsodium";
import * as FileSystem from "expo-file-system/legacy";

import * as api from "../api/client";
import { ApiError } from "../api/client";
import { getOrCreateIdentity } from "../crypto/identity";
import { initDatabase } from "../db/database";
import { connectSocket, disconnectSocket } from "../network/socket";
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

  // Called both on explicit logout and when the server tells this device
  // it's been superseded by a login elsewhere (see "session:revoked" below).
  const signOutLocally = useCallback(() => {
    disconnectSocket();
    void clearSessionToken();
    void clearSessionEmail();
    void clearProfile();
    setEmail(null);
    setProfile(null);
    setToken(null);
    setStatus("signed-out");
  }, []);

  useEffect(() => {
    (async () => {
      initDatabase();
      await getOrCreateIdentity();

      const storedToken = await loadSessionToken();
      if (!storedToken) {
        setStatus("signed-out");
        return;
      }

      const localProfile = await loadProfile();

      try {
        const session = await api.getSession(storedToken);
        await saveSessionEmail(session.email);
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

        const cachedEmail = await loadSessionEmail();
        if (!cachedEmail) {
          signOutLocally();
          return;
        }

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
      await saveSessionToken(newToken);
      await saveSessionEmail(emailAddress);
      setEmail(emailAddress);
      setToken(newToken);
      connectSocket(newToken).on("session:revoked", signOutLocally);

      const localProfile = await loadProfile();
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
      const identity = await getOrCreateIdentity();
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
      const identity = await getOrCreateIdentity();
      await sodium.ready;
      const publicKey = sodium.to_base64(identity.publicKey);

      const { token: newToken } = await api.devLogin(emailAddress, publicKey);
      await establishSession(emailAddress, newToken);
    },
    [establishSession]
  );

  const completeProfile = useCallback(
    async (fullName: string, photoUri: string | null) => {
      const saved = await saveProfile(fullName, photoUri);
      setProfile(saved);
      setStatus("signed-in");
      if (token) await pushRemoteProfile(token, fullName, photoUri);
    },
    [token]
  );

  const updateProfile = useCallback(
    async (fullName: string, photoUri: string | null) => {
      const saved = await saveProfile(fullName, photoUri);
      setProfile(saved);
      if (token) await pushRemoteProfile(token, fullName, photoUri);
    },
    [token]
  );

  const logout = useCallback(async () => {
    const currentToken = await loadSessionToken();
    if (currentToken) {
      await api.logout(currentToken).catch(() => {});
    }
    signOutLocally();
  }, [signOutLocally]);

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
    }),
    [status, email, profile, token, requestOtp, verifyOtp, devLogin, completeProfile, updateProfile, logout]
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

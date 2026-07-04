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

import * as api from "../api/client";
import { getOrCreateIdentity } from "../crypto/identity";
import { initDatabase } from "../db/database";
import { connectSocket, disconnectSocket } from "../network/socket";
import { clearProfile, loadProfile, saveProfile, type Profile } from "../storage/profileStore";
import { clearSessionToken, loadSessionToken, saveSessionToken } from "../storage/sessionStore";

type AuthStatus = "loading" | "signed-out" | "needs-profile" | "signed-in";

interface AuthContextValue {
  status: AuthStatus;
  phoneNumber: string | null;
  profile: Profile | null;
  token: string | null;
  requestOtp: (phoneNumber: string) => Promise<void>;
  verifyOtp: (phoneNumber: string, code: string) => Promise<void>;
  completeProfile: (fullName: string, photoUri: string | null) => Promise<void>;
  updateProfile: (fullName: string, photoUri: string | null) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Called both on explicit logout and when the server tells this device
  // it's been superseded by a login elsewhere (see "session:revoked" below).
  const signOutLocally = useCallback(() => {
    disconnectSocket();
    void clearSessionToken();
    void clearProfile();
    setPhoneNumber(null);
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

      try {
        const session = await api.getSession(storedToken);
        setPhoneNumber(session.phoneNumber);
        setToken(storedToken);
        connectSocket(storedToken).on("session:revoked", signOutLocally);

        const localProfile = await loadProfile();
        if (localProfile) {
          setProfile(localProfile);
          setStatus("signed-in");
        } else {
          setStatus("needs-profile");
        }
      } catch {
        signOutLocally();
      }
    })();
  }, [signOutLocally]);

  const requestOtp = useCallback(async (phone: string) => {
    await api.requestOtp(phone);
  }, []);

  const verifyOtp = useCallback(
    async (phone: string, code: string) => {
      const identity = await getOrCreateIdentity();
      await sodium.ready;
      const publicKey = sodium.to_base64(identity.publicKey);

      const { token: newToken } = await api.verifyOtp(phone, code, publicKey);
      await saveSessionToken(newToken);
      setPhoneNumber(phone);
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

  const completeProfile = useCallback(async (fullName: string, photoUri: string | null) => {
    const saved = await saveProfile(fullName, photoUri);
    setProfile(saved);
    setStatus("signed-in");
  }, []);

  const updateProfile = useCallback(async (fullName: string, photoUri: string | null) => {
    const saved = await saveProfile(fullName, photoUri);
    setProfile(saved);
  }, []);

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
      phoneNumber,
      profile,
      token,
      requestOtp,
      verifyOtp,
      completeProfile,
      updateProfile,
      logout,
    }),
    [status, phoneNumber, profile, token, requestOtp, verifyOtp, completeProfile, updateProfile, logout]
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

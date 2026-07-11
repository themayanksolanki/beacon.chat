const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? "http://localhost:4000";

interface RequestOptions extends RequestInit {
  token?: string;
}

// Callers (notably AuthContext's startup check) need to tell "the server
// explicitly rejected this token" (401) apart from "couldn't reach the
// server" (network error, Render cold start, etc.) — only the former should
// ever sign the user out.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, headers, ...rest } = options;

  const res = await fetch(`${SERVER_URL}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `request_failed_${res.status}`, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json();
}

export function requestOtp(email: string) {
  return request<{ ok: true }>("/auth/otp/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export interface LoginResult {
  token: string;
  userId: string;
  deviceId: string;
}

// deviceId/deviceName are optional: omitted on this account's very first
// login on this device, in which case the server registers a new device and
// returns its id — the caller is expected to persist that for next time
// (see AuthContext, storage/secureKeyStore's getOrCreateDeviceId). Sending a
// previously-issued deviceId back reuses that device's identity instead of
// registering a new one, replacing just that device's session server-side.
export function verifyOtp(
  email: string,
  code: string,
  publicKey: string,
  deviceId?: string,
  deviceName?: string | null
) {
  return request<LoginResult>("/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code, publicKey, deviceId, deviceName }),
  });
}

// Dev-only: mirrors verifyOtp but skips the code entirely. Only works while
// the server has SKIP_OTP=true; see EmailEntryScreen for the toggle.
export function devLogin(email: string, publicKey: string, deviceId?: string, deviceName?: string | null) {
  return request<LoginResult>("/auth/dev-login", {
    method: "POST",
    body: JSON.stringify({ email, publicKey, deviceId, deviceName }),
  });
}

export function getSession(token: string) {
  return request<{ userId: string; email: string }>("/auth/session", { token });
}

export interface LinkedDevice {
  id: string;
  name: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  isCurrentDevice: boolean;
}

/** Powers the "Linked Devices" Settings screen. */
export async function listDevices(token: string) {
  const { devices } = await request<{ devices: LinkedDevice[] }>("/devices", { token });
  return devices;
}

// Unlinks a device (including, potentially, this very one — the server
// kicks its live socket via session:revoked, which AuthContext already
// listens for and signs out locally in response).
export function revokeDevice(token: string, deviceId: string) {
  return request<void>(`/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", token });
}

export function logout(token: string) {
  return request<void>("/auth/logout", { method: "POST", token });
}

// Schedules the account for permanent deletion (see server's
// ACCOUNT_DELETION_GRACE_MS); logging back in before then cancels it.
export function requestAccountDeletion(token: string) {
  return request<{ ok: true; deletionScheduledFor: number }>("/auth/account/delete", {
    method: "POST",
    token,
  });
}

export interface LookupMatch {
  email: string;
  userId: string;
  publicKey: string;
  name: string | null;
  avatarUrl: string | null;
}

export async function lookupUsers(token: string, emails: string[]) {
  const { matches } = await request<{ matches: LookupMatch[] }>("/users/lookup", {
    method: "POST",
    token,
    body: JSON.stringify({ emails }),
  });
  return matches;
}

export interface UserDevice {
  deviceId: string;
  publicKey: string;
}

export interface UserLookup {
  userId: string;
  email: string;
  publicKey: string;
  // This peer's currently-active linked devices — encrypt once per device
  // for real multi-device delivery instead of the single (and, once a
  // second device logs in, stale) publicKey above. See ChatScreen's send
  // path and storage/database.ts's peer_devices cache.
  devices: UserDevice[];
  name: string | null;
  avatarUrl: string | null;
  // Status line, WhatsApp-style ("Hey there! I am using Beacon."). Not
  // surfaced in any screen yet — no editor UI for it either.
  about: string | null;
  contactNumber: string | null;
  createdAt: number;
}

/** Resolves a bare sender/recipient id to their identity, e.g. to materialize a conversation for an unknown sender. */
export function getUserById(token: string, userId: string) {
  return request<UserLookup>(`/users/by-id/${encodeURIComponent(userId)}`, { token });
}

export function inviteByEmail(token: string, email: string) {
  return request<{ ok: true }>("/users/invite", {
    method: "POST",
    token,
    body: JSON.stringify({ email }),
  });
}

export interface PhoneLookupMatch {
  phoneNumber: string;
  userId: string;
  publicKey: string;
  name: string | null;
  avatarUrl: string | null;
}

export async function lookupUsersByPhone(token: string, phoneNumbers: string[]) {
  const { matches } = await request<{ matches: PhoneLookupMatch[] }>("/users/lookup-by-phone", {
    method: "POST",
    token,
    body: JSON.stringify({ phoneNumbers }),
  });
  return matches;
}

// null clears the stored number; the server never OTP-verifies this field.
export function updatePhoneNumber(token: string, phoneNumber: string | null) {
  return request<{ ok: true }>("/profile/phone", {
    method: "PUT",
    token,
    body: JSON.stringify({ phoneNumber }),
  });
}

// avatarKey omitted entirely => server leaves the stored avatar untouched
// (used for a name-only edit); pass null to explicitly clear it.
export function updateRemoteProfile(token: string, name: string, avatarKey?: string | null) {
  return request<{ ok: true }>("/profile", {
    method: "PUT",
    token,
    body: JSON.stringify(avatarKey !== undefined ? { name, avatarKey } : { name }),
  });
}

export interface AvatarUploadTarget {
  url: string;
  fields: Record<string, string>;
  key: string;
}

export function requestAvatarUploadUrl(token: string) {
  return request<AvatarUploadTarget>("/profile/avatar/upload-url", { method: "POST", token });
}

export type ChatMediaKind = "image" | "video" | "file";

export interface ChatMediaUploadTarget {
  url: string;
  fields: Record<string, string>;
  key: string;
  publicUrl: string;
  maxBytes: number;
}

export function requestChatMediaUploadUrl(token: string, messageId: string, kind: ChatMediaKind) {
  return request<ChatMediaUploadTarget>("/media/chat/upload-url", {
    method: "POST",
    token,
    body: JSON.stringify({ messageId, kind }),
  });
}

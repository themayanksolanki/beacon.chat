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

export function verifyOtp(email: string, code: string, publicKey: string) {
  return request<{ token: string; userId: string }>("/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code, publicKey }),
  });
}

// Dev-only: mirrors verifyOtp but skips the code entirely. Only works while
// the server has SKIP_OTP=true; see EmailEntryScreen for the toggle.
export function devLogin(email: string, publicKey: string) {
  return request<{ token: string; userId: string }>("/auth/dev-login", {
    method: "POST",
    body: JSON.stringify({ email, publicKey }),
  });
}

export function getSession(token: string) {
  return request<{ userId: string; email: string }>("/auth/session", { token });
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

export interface UserLookup {
  userId: string;
  email: string;
  publicKey: string;
  name: string | null;
  avatarUrl: string | null;
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

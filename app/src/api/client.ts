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

export function getSession(token: string) {
  return request<{ userId: string; email: string }>("/auth/session", { token });
}

export function logout(token: string) {
  return request<void>("/auth/logout", { method: "POST", token });
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

export function inviteByEmail(token: string, email: string) {
  return request<{ ok: true }>("/users/invite", {
    method: "POST",
    token,
    body: JSON.stringify({ email }),
  });
}

export function updateRemoteProfile(token: string, name: string, avatarUrl: string | null) {
  return request<{ ok: true }>("/profile", {
    method: "PUT",
    token,
    body: JSON.stringify({ name, avatarUrl }),
  });
}

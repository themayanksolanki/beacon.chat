const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? "http://localhost:4000";

interface RequestOptions extends RequestInit {
  token?: string;
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
    throw new Error(body.error ?? `request_failed_${res.status}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json();
}

export function requestOtp(phoneNumber: string) {
  return request<{ ok: true }>("/auth/otp/request", {
    method: "POST",
    body: JSON.stringify({ phoneNumber }),
  });
}

export function verifyOtp(phoneNumber: string, code: string, publicKey: string) {
  return request<{ token: string; userId: string }>("/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phoneNumber, code, publicKey }),
  });
}

export function getSession(token: string) {
  return request<{ userId: string; phoneNumber: string }>("/auth/session", { token });
}

export function logout(token: string) {
  return request<void>("/auth/logout", { method: "POST", token });
}

export interface LookupMatch {
  phoneNumber: string;
  userId: string;
  publicKey: string;
}

export async function lookupUsers(token: string, phoneNumbers: string[]) {
  const { matches } = await request<{ matches: LookupMatch[] }>("/users/lookup", {
    method: "POST",
    token,
    body: JSON.stringify({ phoneNumbers }),
  });
  return matches;
}

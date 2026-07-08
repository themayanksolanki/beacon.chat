// Normalizes an account identifier (email) into a key safe for use in
// SQLite filenames and SecureStore aliases, so per-account local data can be
// namespaced when multiple accounts sign into the same device.
export function sanitizeAccountKey(accountKey: string): string {
  return accountKey.trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
}

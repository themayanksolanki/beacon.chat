/**
 * Emails are case-insensitive in practice (and RFC 5321 recommends treating
 * them that way for the mailbox part too). Every write to `users.email` and
 * every lookup against it must go through this so "Bob@x.com" and
 * "bob@x.com" are always the same account.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

import { Alert, Linking } from "react-native";

// Deliberately conservative: scheme-based (http/https) and www.-prefixed
// links always match; bare domains only match against a finite whitelist of
// common TLDs, so ordinary sentence punctuation ("Mr. Smith", "e.g. that")
// never gets mistaken for a link. This same regex backs both the inline
// chat linkification (see the Linkify component) and the Links tab/count
// (see ContactInfoScreen/SharedMediaScreen), so a link recognized in one
// place is always recognized in the other.
const COMMON_TLDS =
  "com|net|org|io|dev|co|app|ai|edu|gov|info|biz|me|us|uk|ca|de|fr|in|xyz|tv|so|to|ly|gg|chat";

export const URL_REGEX = new RegExp(
  `(https?:\\/\\/[^\\s]+)` +
    `|(www\\.[^\\s]+)` +
    `|(\\b[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\\.(?:${COMMON_TLDS})(?:\\.[a-zA-Z]{2,})?(?:\\/[^\\s]*)?)`,
  "gi"
);

/** Strips trailing punctuation that reads as part of the sentence rather than the URL itself (e.g. "check example.com." or "(example.com)"). */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[).,!?;:'"]+$/, "");
}

/** True if `text[matchIndex]` is immediately preceded by "@" — the bare-domain branch of URL_REGEX would otherwise mistake the domain half of an email address (foo@example.com) for a link. */
function isEmailLike(text: string, matchIndex: number): boolean {
  return matchIndex > 0 && text[matchIndex - 1] === "@";
}

/** Adds a scheme to a www./bare-domain match so it's actually openable — Linking.openURL requires one. */
export function normalizeUrl(rawUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  return `https://${rawUrl}`;
}

/** Every distinct URL found in `text`, in the order first seen, trailing sentence punctuation stripped. */
export function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of text.matchAll(URL_REGEX)) {
    const start = match.index ?? 0;
    if (isEmailLike(text, start)) continue;
    const trimmed = trimTrailingPunctuation(match[0]);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    links.push(trimmed);
  }
  return links;
}

/**
 * Opens a detected link in the system browser. Only ever called with text
 * this module's own regex matched (http(s):// or www./bare-domain — never an
 * arbitrary scheme like tel:/intent:), and the http(s):// check below is a
 * second, defensive guard against opening anything else.
 */
export async function openLink(rawUrl: string): Promise<void> {
  const url = normalizeUrl(trimTrailingPunctuation(rawUrl));
  if (!/^https?:\/\//i.test(url)) return;
  try {
    await Linking.openURL(url);
  } catch (err) {
    console.warn("[linkify] failed to open link", err);
    Alert.alert("Couldn't open link", "Please check the link and try again.");
  }
}

export interface LinkTextSegment {
  text: string;
  isLink: boolean;
}

/** Splits `text` into plain/link segments for rendering — see components/Linkify.tsx, which turns each link segment into a tappable nested <Text>. */
export function splitIntoLinkSegments(text: string): LinkTextSegment[] {
  const segments: LinkTextSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (isEmailLike(text, start)) continue;
    const trimmed = trimTrailingPunctuation(raw);
    if (!trimmed) continue;
    if (start > lastIndex) segments.push({ text: text.slice(lastIndex, start), isLink: false });
    segments.push({ text: trimmed, isLink: true });
    // Whatever punctuation was trimmed off the match (e.g. a trailing
    // period) still belongs in the surrounding plain text, not dropped.
    if (trimmed.length < raw.length) {
      segments.push({ text: raw.slice(trimmed.length), isLink: false });
    }
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), isLink: false });
  return segments;
}

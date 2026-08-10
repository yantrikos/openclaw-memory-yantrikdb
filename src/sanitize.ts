/**
 * Capture-side sanitization. Everything that flows from conversation into
 * long-term storage passes through here first:
 *  - obvious credentials are redacted (better to lose a token from memory
 *    than to persist it),
 *  - control characters and ANSI sequences are stripped,
 *  - length is clamped so a pasted log file cannot become a "memory".
 */

const REDACTED = "[redacted]";

const SECRET_PATTERNS: RegExp[] = [
  // PEM blocks (private keys).
  /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,32}PRIVATE KEY-----/g,
  // Bearer / Authorization headers.
  /\b(authorization\s*:\s*)?bearer\s+[a-z0-9._~+/=-]{16,}/gi,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // OpenAI-style secret keys.
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
];

// key=value / key: value assignments for secret-ish names. Kept separate so
// the replacement can preserve the key name while dropping the value.
const KEY_VALUE_SECRET =
  /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|private[_-]?key)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi;

/** Replace credential-shaped substrings with a redaction marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(
    KEY_VALUE_SECRET,
    (_match, keyName: string, separator: string) =>
      `${keyName}${separator}${REDACTED}`,
  );
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
// Control characters except \n (\x0a) and \t (\x09).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip ANSI escapes and non-printable control characters. */
export function stripControlSequences(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "");
}

/** Clamp to maxChars without splitting a surrogate pair. */
export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

/** Full pipeline used before any conversation text is persisted. */
export function sanitizeForCapture(text: string, maxChars = 2000): string {
  const cleaned = stripControlSequences(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return clampText(redactSecrets(cleaned), maxChars);
}

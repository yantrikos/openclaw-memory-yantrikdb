import { sanitizeForCapture } from "./sanitize.js";

/**
 * Pure helpers for auto-capture: pulling capturable text out of the
 * hook-event message array (whose exact shape varies by channel) and
 * compiling a bounded session summary. Kept free of SDK imports so they
 * are unit-testable outside an OpenClaw host.
 */

interface LooseMessage {
  role?: unknown;
  content?: unknown;
  text?: unknown;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          part &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string"
        ) {
          return (part as Record<string, unknown>).text as string;
        }
        return "";
      })
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}

/** Extract sanitized texts for a given role from a loose message array. */
export function extractRoleTexts(
  messages: unknown,
  role: "user" | "assistant",
  options: { minChars?: number; maxChars?: number } = {},
): string[] {
  const minChars = options.minChars ?? 24;
  const maxChars = options.maxChars ?? 2000;
  if (!Array.isArray(messages)) {
    return [];
  }
  const texts: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as LooseMessage;
    if (message.role !== role) {
      continue;
    }
    const body = contentToText(message.content ?? message.text);
    const clean = sanitizeForCapture(body, maxChars);
    if (clean.length >= minChars) {
      texts.push(clean);
    }
  }
  return texts;
}

/** FNV-1a 32-bit hex — deterministic ids for idempotent capture writes. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Join snippet parts into a bounded end-of-session summary. */
export function buildSessionSummary(
  parts: readonly string[],
  maxChars = 4000,
): string | undefined {
  const joined = parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n")
    .trim();
  if (joined.length === 0) {
    return undefined;
  }
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

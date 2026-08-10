import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampText,
  redactSecrets,
  sanitizeForCapture,
  stripControlSequences,
} from "../src/sanitize.js";

describe("redactSecrets", () => {
  it("redacts bearer tokens", () => {
    const out = redactSecrets(
      "curl -H 'Authorization: Bearer abcdef1234567890abcdef' https://x",
    );
    assert.ok(!out.includes("abcdef1234567890abcdef"));
    assert.match(out, /\[redacted\]/);
  });

  it("redacts AWS access key ids", () => {
    const out = redactSecrets("key AKIAIOSFODNN7EXAMPLE used");
    assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  });

  it("redacts github and openai style tokens", () => {
    const out = redactSecrets(
      "ghp_0123456789abcdefghijklmn and sk-abcdefghijklmnopqrstuv",
    );
    assert.ok(!out.includes("ghp_0123456789abcdefghijklmn"));
    assert.ok(!out.includes("sk-abcdefghijklmnopqrstuv"));
  });

  it("keeps key names but drops values in assignments", () => {
    const out = redactSecrets("set API_KEY=supersecretvalue123 in the env");
    assert.match(out, /API_KEY=\[redacted\]/);
    assert.ok(!out.includes("supersecretvalue123"));
  });

  it("redacts PEM private key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`before ${pem} after`);
    assert.ok(!out.includes("MIIEow"));
    assert.match(out, /before \[redacted\] after/);
  });

  it("leaves ordinary prose alone", () => {
    const text = "User prefers dark mode and tabs over spaces.";
    assert.equal(redactSecrets(text), text);
  });
});

describe("stripControlSequences", () => {
  it("removes ANSI escapes and control chars but keeps newlines/tabs", () => {
    const input = "\x1b[31mred\x1b[0m line\n\tok\x07";
    assert.equal(stripControlSequences(input), "red line\n\tok");
  });
});

describe("clampText", () => {
  it("returns short text unchanged", () => {
    assert.equal(clampText("short", 10), "short");
  });

  it("clamps long text with an ellipsis", () => {
    const out = clampText("x".repeat(20), 10);
    assert.equal(out.length, 11);
    assert.ok(out.endsWith("…"));
  });

  it("does not split surrogate pairs", () => {
    const emoji = "😀".repeat(6); // each emoji is 2 UTF-16 units
    const out = clampText(emoji, 5);
    // The 5th unit would be a lone high surrogate; the clamp backs off.
    assert.equal(out, `${"😀".repeat(2)}…`);
  });
});

describe("sanitizeForCapture", () => {
  it("runs the full pipeline", () => {
    const input =
      "  token=abcdefgh12345678\r\nplain line   \n\x1b[1mbold\x1b[0m  ";
    const out = sanitizeForCapture(input, 200);
    assert.match(out, /token=\[redacted\]/);
    assert.match(out, /plain line/);
    assert.match(out, /bold/);
    assert.ok(!out.includes("\r"));
    assert.ok(!out.includes("\x1b"));
  });

  it("clamps oversized input", () => {
    const out = sanitizeForCapture("y".repeat(10000), 100);
    assert.equal(out.length, 101);
  });
});

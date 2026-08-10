import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSessionSummary,
  extractRoleTexts,
  fnv1a,
} from "../src/capture.js";

describe("extractRoleTexts", () => {
  it("pulls user texts from string and array content", () => {
    const messages = [
      { role: "user", content: "Remember that I deploy on Fridays only." },
      { role: "assistant", content: "Noted." },
      {
        role: "user",
        content: [
          { type: "text", text: "Also the staging box is CT173, not CT167." },
          { type: "image", url: "ignored" },
        ],
      },
    ];
    const texts = extractRoleTexts(messages, "user");
    assert.equal(texts.length, 2);
    assert.match(texts[0]!, /Fridays only/);
    assert.match(texts[1]!, /CT173/);
  });

  it("skips short, empty, and malformed entries", () => {
    const texts = extractRoleTexts(
      [
        { role: "user", content: "ok" },
        { role: "user" },
        null,
        "not-an-object",
        { role: "user", content: 42 },
      ],
      "user",
    );
    assert.deepEqual(texts, []);
  });

  it("sanitizes captured content", () => {
    const texts = extractRoleTexts(
      [
        {
          role: "user",
          content: "my token=abcdefgh12345678 should never persist in memory",
        },
      ],
      "user",
    );
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /token=\[redacted\]/);
  });

  it("returns [] for non-array input", () => {
    assert.deepEqual(extractRoleTexts(undefined, "user"), []);
    assert.deepEqual(extractRoleTexts("nope", "user"), []);
  });
});

describe("fnv1a", () => {
  it("is deterministic and 8 hex chars", () => {
    assert.equal(fnv1a("hello"), fnv1a("hello"));
    assert.match(fnv1a("hello"), /^[0-9a-f]{8}$/);
    assert.notEqual(fnv1a("hello"), fnv1a("hellp"));
  });
});

describe("buildSessionSummary", () => {
  it("joins parts and trims", () => {
    assert.equal(buildSessionSummary(["a fact", "  another  "]), "a fact\nanother");
  });

  it("returns undefined when empty", () => {
    assert.equal(buildSessionSummary([]), undefined);
    assert.equal(buildSessionSummary(["   "]), undefined);
  });

  it("bounds the summary length", () => {
    const out = buildSessionSummary(["x".repeat(5000)], 100);
    assert.ok(out);
    assert.equal(out!.length, 101);
  });
});

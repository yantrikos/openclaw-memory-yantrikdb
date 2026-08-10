import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatRecallResults,
  formatSessionDigest,
  trustWarnings,
  UNTRUSTED_HEDGE,
} from "../src/format.js";

describe("formatRecallResults", () => {
  it("renders results with metadata, hedge, and ids", () => {
    const text = formatRecallResults({
      results: [
        {
          rid: "r1",
          text: "User prefers dark mode",
          score: 0.91,
          importance: 0.7,
          memory_type: "semantic",
          why_retrieved: ["semantically similar (0.78)"],
          domain: "preference",
        },
      ],
    });
    assert.match(text, /Found 1 memory:/);
    assert.ok(text.includes(UNTRUSTED_HEDGE));
    assert.match(text, /User prefers dark mode/);
    assert.match(text, /score 0\.91/);
    assert.match(text, /id r1/);
  });

  it("flags stale or disputed hits from why_retrieved markers", () => {
    const text = formatRecallResults({
      results: [
        {
          rid: "r2",
          text: "Old fact",
          why_retrieved: ["110d old, rarely confirmed - verify it is still current"],
        },
      ],
    });
    assert.match(text, /\[verify: may be stale or disputed\]/);
  });

  it("notes the keyword fallback", () => {
    const text = formatRecallResults({
      results: [{ rid: "r3", text: "kw hit" }],
      fallback: "fts5_keyword",
    });
    assert.match(text, /keyword matches/);
  });

  it("handles empty results", () => {
    assert.equal(formatRecallResults({ results: [] }), "No memories matched.");
  });
});

describe("trustWarnings", () => {
  it("returns only warning-shaped reasons", () => {
    const warnings = trustWarnings({
      rid: "r",
      text: "t",
      why_retrieved: [
        "semantically similar (0.6)",
        "superseded by a newer record",
      ],
    });
    assert.deepEqual(warnings, ["superseded by a newer record"]);
  });
});

describe("formatSessionDigest", () => {
  it("renders known sections defensively across shapes", () => {
    const text = formatSessionDigest({
      narrative_head: { text: "Working on the OpenClaw plugin." },
      open_decisions: ["Pick the adapter build order", { text: "Show HN date" }],
      unresolved_conflicts: [{ snippet: "Port 7438 vs 8438" }],
      pending_triggers: [],
      knowledge_gaps: [{ question: "Which embedder in prod?" }],
    });
    assert.ok(text);
    assert.match(text!, /## Memory briefing \(YantrikDB\)/);
    assert.match(text!, /Where things stand: Working on the OpenClaw plugin\./);
    assert.match(text!, /Open decisions:/);
    assert.match(text!, /- Pick the adapter build order/);
    assert.match(text!, /- Show HN date/);
    assert.match(text!, /Unresolved conflicts/);
    assert.match(text!, /Known unknowns:/);
    assert.ok(text!.includes(UNTRUSTED_HEDGE));
  });

  it("returns undefined for an empty digest", () => {
    assert.equal(formatSessionDigest({}), undefined);
    assert.equal(
      formatSessionDigest({ open_decisions: [], conflicts: [] }),
      undefined,
    );
  });

  it("respects the size bound", () => {
    const text = formatSessionDigest(
      {
        open_decisions: Array.from({ length: 50 }, (_, i) =>
          `decision ${i} ${"x".repeat(200)}`,
        ),
      },
      500,
    );
    assert.ok(text);
    assert.ok(text!.length <= 501, `length was ${text!.length}`);
  });
});

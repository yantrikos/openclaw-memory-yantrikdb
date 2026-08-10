# Changelog

## 0.1.0 — 2026-08-09

Initial release.

- Memory-slot plugin (`kind: "memory"`, id `memory-yantrikdb`) for OpenClaw,
  backed by the YantrikDB HTTP gateway (`/v1` API) over plain `fetch` —
  no subprocesses, no filesystem access, one runtime dependency (`typebox`).
- Tools: `memory_recall` (retrieval reasons + stale/disputed flags,
  keyword-fallback notice), `memory_store` (importance/type/domain,
  secret-redacted), `memory_forget` (tombstone with reason).
- Hooks: `before_prompt_build` injects YantrikDB's session digest (open
  decisions, unresolved conflicts, pending triggers, known unknowns) as a
  bounded briefing, cached per session; `agent_end` auto-captures new user
  messages as episodic memories (idempotent when the server advertises
  `idempotency_key`); `session_end` hands a bounded summary to
  `/v1/session/end` for engine-side fact segmentation.
- Capture sanitization: ANSI/control stripping, credential redaction
  (bearer/AWS/GitHub/Slack/OpenAI-style tokens, PEM blocks, key=value
  assignments), surrogate-safe length clamping.
- Incognito sessions: no injection, no capture.
- Fail-open error handling throughout; per-request timeouts
  (default 4000 ms); rate-limited warnings.
- 37 unit tests (client wire format against a scripted HTTP double,
  formatting, sanitization, capture helpers).

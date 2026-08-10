import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/routing";
import type { YantrikDbClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { buildSessionSummary, extractRoleTexts, fnv1a } from "./capture.js";
import { formatSessionDigest } from "./format.js";

/**
 * Lifecycle wiring.
 *
 *  before_prompt_build — inject YantrikDB's session digest (open decisions,
 *    unresolved conflicts, pending triggers, known unknowns) as a bounded
 *    boot briefing. Cached per session so a chatty session costs one
 *    digest call, not one per message.
 *
 *  agent_end — capture new user messages as low-importance episodic
 *    memories (idempotent when the server supports it) and buffer them
 *    toward the session summary.
 *
 *  session_end — hand the buffered summary to /v1/session/end, where the
 *    engine segments it into atomic provisional facts (RFC 027). Then
 *    drop all per-session state.
 *
 * Every handler is fail-open: memory being down must never take the agent
 * down. Failures log at warn, rate-limited to once a minute.
 */

const DIGEST_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 64;
const MAX_CAPTURES_PER_RUN = 4;
const WARN_INTERVAL_MS = 60 * 1000;

interface SessionState {
  digestAt: number;
  digestText: string | undefined;
  captureCursor: number;
  summaryParts: string[];
  capturedHashes: Set<string>;
}

export function registerMemoryHooks(
  api: OpenClawPluginApi,
  client: YantrikDbClient,
  cfg: ResolvedConfig,
): void {
  const sessions = new Map<string, SessionState>();
  let lastWarnAt = 0;

  const warn = (message: string): void => {
    const now = Date.now();
    if (now - lastWarnAt >= WARN_INTERVAL_MS) {
      lastWarnAt = now;
      api.logger.warn(`[memory-yantrikdb] ${message}`);
    }
  };

  const sessionState = (key: string): SessionState => {
    let state = sessions.get(key);
    if (!state) {
      // Bounded map: evict the oldest entry rather than growing forever
      // in long-running gateways.
      if (sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) {
          sessions.delete(oldest);
        }
      }
      state = {
        digestAt: 0,
        digestText: undefined,
        captureCursor: 0,
        summaryParts: [],
        capturedHashes: new Set(),
      };
      sessions.set(key, state);
    }
    return state;
  };

  api.on("before_prompt_build", async (_event, ctx) => {
    if (!cfg.autoRecall || !cfg.injectSessionDigest) {
      return undefined;
    }
    const sessionKey = ctx.sessionKey ?? "default";
    if (isIncognitoSessionKey(ctx.sessionKey)) {
      return undefined;
    }
    const state = sessionState(sessionKey);
    const now = Date.now();
    if (now - state.digestAt > DIGEST_TTL_MS) {
      state.digestAt = now;
      try {
        const digest = await client.sessionDigest({
          namespace: cfg.namespace,
          includeGaps: true,
        });
        state.digestText = formatSessionDigest(digest, cfg.maxContextChars);
      } catch (error) {
        state.digestText = undefined;
        warn(
          `session digest unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return state.digestText ? { prependContext: state.digestText } : undefined;
  });

  api.on("agent_end", async (event, ctx) => {
    if (!cfg.autoCapture) {
      return;
    }
    const sessionKey = ctx.sessionKey ?? "default";
    if (isIncognitoSessionKey(ctx.sessionKey)) {
      return;
    }
    const state = sessionState(sessionKey);
    const allTexts = extractRoleTexts(event.messages, "user");
    const fresh = allTexts.slice(state.captureCursor);
    state.captureCursor = allTexts.length;

    let captured = 0;
    for (const text of fresh) {
      if (captured >= MAX_CAPTURES_PER_RUN) {
        break;
      }
      const hash = fnv1a(text);
      if (state.capturedHashes.has(hash)) {
        continue;
      }
      state.capturedHashes.add(hash);
      state.summaryParts.push(text);
      try {
        await client.remember({
          text,
          memory_type: "episodic",
          importance: cfg.captureImportance,
          domain: cfg.domain,
          namespace: cfg.namespace,
          source: "inference",
          metadata: { channel: "openclaw", auto_captured: true },
          ...(client.supportsIdempotency()
            ? { idempotency_key: `openclaw:${sessionKey}:${hash}` }
            : {}),
        });
        captured += 1;
      } catch (error) {
        warn(
          `auto-capture failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }
    }
  });

  api.on("session_end", async (_event, ctx) => {
    const sessionKey = ctx.sessionKey ?? "default";
    const state = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    if (!state || !cfg.autoCapture) {
      return;
    }
    const summary = buildSessionSummary(state.summaryParts);
    if (!summary) {
      return;
    }
    try {
      await client.sessionEnd(summary, {
        namespace: cfg.namespace,
        domain: cfg.domain,
      });
    } catch (error) {
      warn(
        `session-end capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

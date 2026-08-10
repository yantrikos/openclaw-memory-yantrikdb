import { Type } from "typebox";
import type {
  OpenClawPluginApi,
  PluginToolResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { YantrikDbError, type YantrikDbClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { formatRecallResults } from "./format.js";
import { sanitizeForCapture } from "./sanitize.js";

/**
 * The three memory-slot tools. Names follow the convention set by the
 * in-tree engine-style memory plugins (memory_recall / memory_store /
 * memory_forget) so prompts and workflows written against one memory
 * backend keep working when the slot points at YantrikDB.
 */

function textResult(
  text: string,
  details?: Record<string, unknown>,
): PluginToolResult {
  const result: PluginToolResult = { content: [{ type: "text", text }] };
  if (details) {
    result.details = details;
  }
  return result;
}

function errorResult(error: unknown, action: string): PluginToolResult {
  const message =
    error instanceof YantrikDbError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    content: [
      {
        type: "text",
        text: `Memory ${action} failed: ${message}. Memory is temporarily unavailable; continue without it.`,
      },
    ],
    isError: true,
  };
}

const MEMORY_TYPES = ["semantic", "episodic", "procedural"] as const;

export function registerMemoryTools(
  api: OpenClawPluginApi,
  client: YantrikDbClient,
  cfg: ResolvedConfig,
): void {
  api.registerTool(
    {
      name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search long-term memory. Use when you need context about user preferences, past decisions, people, " +
        "or previously discussed topics. Results include why each memory was retrieved and flag entries " +
        "that may be stale or disputed.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "Short natural-language question (5-10 words works best), not a keyword list.",
        }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50,
            description: `Max results (default: ${cfg.recallLimit}).`,
          }),
        ),
        memory_type: Type.Optional(
          Type.Union(
            MEMORY_TYPES.map((t) => Type.Literal(t)),
            { description: "Filter by memory type." },
          ),
        ),
      }),
      async execute(_toolCallId, params) {
        const raw = (params ?? {}) as Record<string, unknown>;
        const query = typeof raw.query === "string" ? raw.query.trim() : "";
        if (query.length === 0) {
          return textResult("memory_recall needs a non-empty query.");
        }
        const limit =
          typeof raw.limit === "number" && Number.isFinite(raw.limit)
            ? Math.min(50, Math.max(1, Math.round(raw.limit)))
            : cfg.recallLimit;
        const memoryType =
          typeof raw.memory_type === "string" &&
          (MEMORY_TYPES as readonly string[]).includes(raw.memory_type)
            ? raw.memory_type
            : undefined;
        try {
          const response = await client.recall(query, {
            topK: limit,
            namespace: cfg.namespace,
            ...(memoryType ? { memoryType } : {}),
          });
          return textResult(formatRecallResults(response), {
            count: response.results.length,
            fallback: response.fallback ?? null,
          });
        } catch (error) {
          return errorResult(error, "recall");
        }
      },
    },
    { name: "memory_recall" },
  );

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save durable information to long-term memory: decisions, preferences, facts about people or " +
        "projects, corrections. Be specific and searchable. Do not store secrets, ephemeral task chatter, " +
        "or anything derivable from files.",
      parameters: Type.Object({
        text: Type.String({
          description: "The fact to remember, written to be findable later.",
        }),
        importance: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 1,
            description:
              "0.8-1.0 critical decisions, 0.5-0.7 useful context, 0.3-0.5 background (default: 0.6).",
          }),
        ),
        memory_type: Type.Optional(
          Type.Union(
            MEMORY_TYPES.map((t) => Type.Literal(t)),
            {
              description:
                "semantic = facts, episodic = events, procedural = how-to (default: semantic).",
            },
          ),
        ),
        category: Type.Optional(
          Type.String({
            description:
              "Domain tag such as work, preference, people, architecture, infrastructure.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const raw = (params ?? {}) as Record<string, unknown>;
        const text =
          typeof raw.text === "string"
            ? sanitizeForCapture(raw.text, 4000)
            : "";
        if (text.length === 0) {
          return textResult("memory_store needs non-empty text.");
        }
        const importance =
          typeof raw.importance === "number" && Number.isFinite(raw.importance)
            ? Math.min(1, Math.max(0, raw.importance))
            : 0.6;
        const memoryType =
          typeof raw.memory_type === "string" &&
          (MEMORY_TYPES as readonly string[]).includes(raw.memory_type)
            ? raw.memory_type
            : "semantic";
        const domain =
          typeof raw.category === "string" && raw.category.trim().length > 0
            ? raw.category.trim().toLowerCase()
            : cfg.domain;
        try {
          const { rid } = await client.remember({
            text,
            importance,
            memory_type: memoryType,
            domain,
            namespace: cfg.namespace,
            source: "agent",
          });
          return textResult(`Stored (id ${rid}, importance ${importance}).`, {
            rid,
          });
        } catch (error) {
          return errorResult(error, "store");
        }
      },
    },
    { name: "memory_store" },
  );

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description:
        "Delete one specific memory by id (ids appear in memory_recall results). The deletion is recorded " +
        "as a tombstone with the given reason.",
      parameters: Type.Object({
        memoryId: Type.String({
          description: "The memory id (rid) to delete.",
        }),
        reason: Type.Optional(
          Type.String({
            description: "Why this memory is being removed.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const raw = (params ?? {}) as Record<string, unknown>;
        const rid =
          typeof raw.memoryId === "string" ? raw.memoryId.trim() : "";
        if (rid.length === 0) {
          return textResult(
            "memory_forget needs a memoryId. Use memory_recall first to find it.",
          );
        }
        const reason =
          typeof raw.reason === "string" && raw.reason.trim().length > 0
            ? raw.reason.trim()
            : undefined;
        try {
          await client.forget(rid, {
            namespace: cfg.namespace,
            ...(reason ? { reason } : {}),
          });
          return textResult(`Forgot memory ${rid}.`, { rid });
        } catch (error) {
          return errorResult(error, "forget");
        }
      },
    },
    { name: "memory_forget" },
  );
}

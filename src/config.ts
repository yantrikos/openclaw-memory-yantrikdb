import { Type, type Static } from "typebox";

/**
 * TypeBox schema for the plugin config. Must stay in sync with the
 * `configSchema` block in openclaw.plugin.json (the manifest copy is what
 * OpenClaw validates without executing plugin code; this copy is what the
 * runtime uses).
 */
export const memoryYantrikDbConfigSchema = Type.Object(
  {
    baseUrl: Type.Optional(
      Type.String({
        description:
          "YantrikDB HTTP gateway URL. Defaults to http://127.0.0.1:7438 (or YANTRIKDB_URL).",
      }),
    ),
    apiKey: Type.Optional(
      Type.String({
        description:
          "Bearer token for the YantrikDB gateway. Falls back to YANTRIKDB_API_KEY.",
      }),
    ),
    namespace: Type.Optional(
      Type.String({
        description:
          "Namespace that scopes this agent's memories inside YantrikDB. Default: openclaw.",
      }),
    ),
    domain: Type.Optional(
      Type.String({
        description: "Default domain tag for stored memories. Default: general.",
      }),
    ),
    autoRecall: Type.Optional(
      Type.Boolean({
        description:
          "Inject a memory briefing into the prompt at session start. Default: true.",
      }),
    ),
    autoCapture: Type.Optional(
      Type.Boolean({
        description:
          "Capture durable facts from conversations automatically. Default: true.",
      }),
    ),
    injectSessionDigest: Type.Optional(
      Type.Boolean({
        description:
          "Use YantrikDB's session digest as the boot briefing. Default: true.",
      }),
    ),
    recallLimit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Default number of results for memory_recall. Default: 5.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 250,
        maximum: 60000,
        description: "Per-request timeout in milliseconds. Default: 4000.",
      }),
    ),
    captureImportance: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 1,
        description: "Importance assigned to auto-captured memories. Default: 0.4.",
      }),
    ),
    maxContextChars: Type.Optional(
      Type.Integer({
        minimum: 200,
        maximum: 20000,
        description: "Upper bound on injected briefing size. Default: 2400.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type MemoryYantrikDbConfig = Static<typeof memoryYantrikDbConfigSchema>;

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string | undefined;
  namespace: string;
  domain: string;
  autoRecall: boolean;
  autoCapture: boolean;
  injectSessionDigest: boolean;
  recallLimit: number;
  timeoutMs: number;
  captureImportance: number;
  maxContextChars: number;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:7438";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Merge raw plugin config with environment fallbacks and defaults.
 * Never throws: a memory plugin must not take the whole agent down over a
 * config nit — bad values clamp to sane bounds instead.
 */
export function resolveConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): ResolvedConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const baseUrl = (
    asString(cfg.baseUrl) ??
    asString(env.YANTRIKDB_URL) ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  return {
    baseUrl,
    apiKey: asString(cfg.apiKey) ?? asString(env.YANTRIKDB_API_KEY),
    namespace:
      asString(cfg.namespace) ?? asString(env.YANTRIKDB_NAMESPACE) ?? "openclaw",
    domain: asString(cfg.domain) ?? "general",
    autoRecall: asBoolean(cfg.autoRecall, true),
    autoCapture: asBoolean(cfg.autoCapture, true),
    injectSessionDigest: asBoolean(cfg.injectSessionDigest, true),
    recallLimit: Math.round(asNumber(cfg.recallLimit, 5, 1, 50)),
    timeoutMs: Math.round(asNumber(cfg.timeoutMs, 4000, 250, 60000)),
    captureImportance: asNumber(cfg.captureImportance, 0.4, 0, 1),
    maxContextChars: Math.round(asNumber(cfg.maxContextChars, 2400, 200, 20000)),
  };
}

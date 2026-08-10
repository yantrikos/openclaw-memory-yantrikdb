/**
 * Minimal fetch-based client for the YantrikDB HTTP gateway (v1 API).
 *
 * Design constraints, in order:
 *  1. Zero subprocesses, zero filesystem access, zero dependencies —
 *     network I/O goes only to the single configured base URL.
 *  2. Never hang the agent loop: every request carries an AbortSignal
 *     timeout.
 *  3. Degrade loudly but safely: failures raise YantrikDbError with the
 *     server's own error message where available; callers decide whether
 *     to surface or swallow.
 */

export interface YantrikDbClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class YantrikDbError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "YantrikDbError";
    this.status = status;
  }
}

export interface RecallOptions {
  topK?: number;
  memoryType?: string;
  domain?: string;
  namespace?: string;
  source?: string;
  includeSuperseded?: boolean;
}

export interface RecallResult {
  rid: string;
  text: string;
  score?: number;
  importance?: number;
  memory_type?: string;
  why_retrieved?: string[];
  domain?: string;
  [key: string]: unknown;
}

export interface RecallResponse {
  results: RecallResult[];
  /** "fts5_keyword" when the server fell back to keyword search. */
  fallback?: string | null;
  [key: string]: unknown;
}

export interface RememberInput {
  text: string;
  memory_type?: string;
  importance?: number;
  domain?: string;
  source?: string;
  namespace?: string;
  certainty?: number;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}

export interface HealthInfo {
  status?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface SessionDigestOptions {
  namespace?: string;
  scope?: string;
  includeGaps?: boolean;
  maxDecisions?: number;
  maxConflicts?: number;
  maxTriggers?: number;
  snippetChars?: number;
}

export class YantrikDbClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private capabilities: Set<string> | undefined;

  constructor(options: YantrikDbClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          qs.set(key, String(value));
        }
      }
      const encoded = qs.toString();
      if (encoded) {
        url += `?${encoded}`;
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? `timed out after ${this.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new YantrikDbError(
        `YantrikDB unreachable at ${this.baseUrl} (${reason})`,
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!response.ok) {
      const message =
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).error === "string"
          ? ((parsed as Record<string, unknown>).error as string)
          : `HTTP ${response.status}`;
      throw new YantrikDbError(message, response.status);
    }
    return parsed as T;
  }

  async health(): Promise<HealthInfo> {
    const info = await this.request<HealthInfo>("GET", "/v1/health");
    if (Array.isArray(info.capabilities)) {
      this.capabilities = new Set(
        info.capabilities.filter((c): c is string => typeof c === "string"),
      );
    }
    return info;
  }

  /**
   * True when the server advertised the idempotency_key capability via
   * /v1/health. Unknown (no successful health call yet) counts as false —
   * the write path then simply omits the key.
   */
  supportsIdempotency(): boolean {
    return this.capabilities?.has("idempotency_key") ?? false;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResponse> {
    const body: Record<string, unknown> = {
      query,
      top_k: options.topK ?? 10,
    };
    if (options.memoryType) body.memory_type = options.memoryType;
    if (options.domain) body.domain = options.domain;
    if (options.namespace) body.namespace = options.namespace;
    if (options.source) body.source = options.source;
    if (options.includeSuperseded) body.include_superseded = true;
    const response = await this.request<RecallResponse>(
      "POST",
      "/v1/recall",
      body,
    );
    if (!Array.isArray(response.results)) {
      response.results = [];
    }
    return response;
  }

  /**
   * Store one memory. If the server rejects the idempotency key (for
   * example in cluster mode, where the replicated apply path does not
   * support it yet), retry exactly once without the key — the documented
   * client behavior for YantrikDB's capability probe.
   */
  async remember(input: RememberInput): Promise<{ rid: string }> {
    try {
      return await this.request<{ rid: string }>("POST", "/v1/remember", input);
    } catch (error) {
      const keyRejected =
        input.idempotency_key !== undefined &&
        error instanceof YantrikDbError &&
        typeof error.status === "number" &&
        error.status >= 400 &&
        error.status < 500 &&
        error.message.toLowerCase().includes("idempotency_key");
      if (!keyRejected) {
        throw error;
      }
      const { idempotency_key: _dropped, ...withoutKey } = input;
      return await this.request<{ rid: string }>(
        "POST",
        "/v1/remember",
        withoutKey,
      );
    }
  }

  async forget(
    rid: string,
    options: { reason?: string; namespace?: string } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { rid };
    if (options.reason) body.reason = options.reason;
    if (options.namespace) body.namespace = options.namespace;
    return this.request<Record<string, unknown>>("POST", "/v1/forget", body);
  }

  async sessionDigest(
    options: SessionDigestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "GET",
      "/v1/session/digest",
      undefined,
      {
        namespace: options.namespace,
        scope: options.scope,
        include_gaps: options.includeGaps,
        max_decisions: options.maxDecisions,
        max_conflicts: options.maxConflicts,
        max_triggers: options.maxTriggers,
        snippet_chars: options.snippetChars,
      },
    );
  }

  /**
   * End-of-session capture: the engine segments the summary into atomic,
   * provisional facts (RFC 027). Far higher quality than client-side
   * fact extraction, so auto-capture prefers this path.
   */
  async sessionEnd(
    summary: string,
    options: { namespace?: string; domain?: string } = {},
  ): Promise<{ drafted?: unknown[]; count?: number }> {
    const body: Record<string, unknown> = { summary };
    if (options.namespace) body.namespace = options.namespace;
    if (options.domain) body.domain = options.domain;
    return this.request<{ drafted?: unknown[]; count?: number }>(
      "POST",
      "/v1/session/end",
      body,
    );
  }
}

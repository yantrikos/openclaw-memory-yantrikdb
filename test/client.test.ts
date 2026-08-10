import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { YantrikDbClient, YantrikDbError } from "../src/client.js";

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

/** Tiny scripted YantrikDB gateway double. */
class FakeGateway {
  server: Server;
  requests: RecordedRequest[] = [];
  /** Queue of scripted responses; falls back to 200 {} when empty. */
  responses: Array<{ status: number; body: unknown }> = [];
  baseUrl = "";

  constructor() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        this.requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body: raw.length > 0 ? JSON.parse(raw) : undefined,
        });
        const scripted = this.responses.shift() ?? { status: 200, body: {} };
        res.statusCode = scripted.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(scripted.body));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (address && typeof address === "object") {
      this.baseUrl = `http://127.0.0.1:${address.port}`;
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("YantrikDbClient", () => {
  const gateway = new FakeGateway();
  let client: YantrikDbClient;

  before(async () => {
    await gateway.start();
    client = new YantrikDbClient({
      baseUrl: gateway.baseUrl,
      apiKey: "test-token",
      timeoutMs: 2000,
    });
  });

  after(async () => {
    await gateway.stop();
  });

  it("sends Bearer auth and JSON body on recall", async () => {
    gateway.responses.push({
      status: 200,
      body: {
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
        fallback: null,
      },
    });
    const response = await client.recall("user's editor preferences", {
      topK: 5,
      namespace: "openclaw",
    });
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.rid, "r1");

    const request = gateway.requests.at(-1);
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "/v1/recall");
    assert.equal(request?.authorization, "Bearer test-token");
    assert.deepEqual(request?.body, {
      query: "user's editor preferences",
      top_k: 5,
      namespace: "openclaw",
    });
  });

  it("normalizes a missing results array", async () => {
    gateway.responses.push({ status: 200, body: {} });
    const response = await client.recall("anything");
    assert.deepEqual(response.results, []);
  });

  it("maps server errors to YantrikDbError with the server message", async () => {
    gateway.responses.push({
      status: 400,
      body: { error: "missing 'query'" },
    });
    await assert.rejects(
      () => client.recall(""),
      (error: unknown) => {
        assert.ok(error instanceof YantrikDbError);
        assert.equal(error.message, "missing 'query'");
        assert.equal(error.status, 400);
        return true;
      },
    );
  });

  it("retries remember once without idempotency_key when the server rejects it", async () => {
    gateway.responses.push({
      status: 400,
      body: {
        error:
          "idempotency_key is not yet supported in cluster mode: retry without the key",
      },
    });
    gateway.responses.push({ status: 200, body: { rid: "r2" } });

    const { rid } = await client.remember({
      text: "fact",
      namespace: "openclaw",
      idempotency_key: "openclaw:s1:abcd1234",
    });
    assert.equal(rid, "r2");

    const firstBody = gateway.requests.at(-2)?.body as Record<string, unknown>;
    const secondBody = gateway.requests.at(-1)?.body as Record<string, unknown>;
    assert.equal(firstBody.idempotency_key, "openclaw:s1:abcd1234");
    assert.equal(secondBody.idempotency_key, undefined);
    assert.equal(secondBody.text, "fact");
  });

  it("does not retry remember on unrelated errors", async () => {
    gateway.responses.push({
      status: 500,
      body: { error: "engine error: disk full" },
    });
    const requestCountBefore = gateway.requests.length;
    await assert.rejects(
      () =>
        client.remember({ text: "fact", idempotency_key: "openclaw:s1:x" }),
      /disk full/,
    );
    assert.equal(gateway.requests.length, requestCountBefore + 1);
  });

  it("caches capabilities from health for supportsIdempotency", async () => {
    assert.equal(client.supportsIdempotency(), false);
    gateway.responses.push({
      status: 200,
      body: { status: "ok", capabilities: ["idempotency_key"] },
    });
    await client.health();
    assert.equal(client.supportsIdempotency(), true);
  });

  it("serializes session digest params as a query string", async () => {
    gateway.responses.push({ status: 200, body: { open_decisions: [] } });
    await client.sessionDigest({
      namespace: "openclaw",
      includeGaps: true,
      maxDecisions: 3,
    });
    const request = gateway.requests.at(-1);
    assert.equal(request?.method, "GET");
    assert.ok(request?.url?.startsWith("/v1/session/digest?"));
    const url = new URL(`http://x${request?.url}`);
    assert.equal(url.searchParams.get("namespace"), "openclaw");
    assert.equal(url.searchParams.get("include_gaps"), "true");
    assert.equal(url.searchParams.get("max_decisions"), "3");
  });

  it("sends rid and reason on forget", async () => {
    gateway.responses.push({ status: 200, body: { ok: true } });
    await client.forget("r9", { reason: "user asked", namespace: "openclaw" });
    const request = gateway.requests.at(-1);
    assert.equal(request?.url, "/v1/forget");
    assert.deepEqual(request?.body, {
      rid: "r9",
      reason: "user asked",
      namespace: "openclaw",
    });
  });

  it("fails fast with a clear message when the server is unreachable", async () => {
    const dead = new YantrikDbClient({
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 500,
    });
    await assert.rejects(
      () => dead.recall("anything"),
      (error: unknown) => {
        assert.ok(error instanceof YantrikDbError);
        assert.match(error.message, /unreachable/);
        return true;
      },
    );
  });
});

import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { YantrikDbClient } from "./src/client.js";
import { memoryYantrikDbConfigSchema, resolveConfig } from "./src/config.js";
import { registerMemoryHooks } from "./src/hooks.js";
import { registerMemoryTools } from "./src/tools.js";

/**
 * Memory (YantrikDB) — an OpenClaw memory-slot plugin backed by a
 * YantrikDB server.
 *
 * Select it with:
 *   plugins.slots.memory = "memory-yantrikdb"
 *
 * Security posture, by construction:
 *  - no subprocesses, no filesystem access, no eval;
 *  - network I/O goes exclusively to the configured YantrikDB base URL;
 *  - recalled memories are injected with an explicit untrusted-data hedge;
 *  - captured text passes secret redaction before it is stored.
 */
export default definePluginEntry({
  id: "memory-yantrikdb",
  name: "Memory (YantrikDB)",
  description:
    "YantrikDB-backed cognitive memory: recall with retrieval reasons, conflict-aware session briefings, auto-capture.",
  kind: "memory" as const,
  configSchema: memoryYantrikDbConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    const client = new YantrikDbClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });

    registerMemoryTools(api, client, cfg);
    registerMemoryHooks(api, client, cfg);

    api.registerService({
      id: "memory-yantrikdb",
      async start() {
        try {
          const health = await client.health();
          const caps = Array.isArray(health.capabilities)
            ? health.capabilities.join(", ")
            : "none advertised";
          api.logger.info(
            `[memory-yantrikdb] connected to ${cfg.baseUrl} (status: ${
              health.status ?? "unknown"
            }; capabilities: ${caps})`,
          );
        } catch (error) {
          api.logger.warn(
            `[memory-yantrikdb] YantrikDB not reachable at ${cfg.baseUrl}: ${
              error instanceof Error ? error.message : String(error)
            }. Tools stay registered and will retry per call.`,
          );
        }
      },
    });
  },
});

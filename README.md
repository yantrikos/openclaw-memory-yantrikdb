# Memory (YantrikDB) — OpenClaw plugin

Your agent forgets your project every session. The default fix — append
facts to a Markdown file and search it — works until the file grows stale:
two contradictory "facts" both match your query, superseded decisions
resurface as current, and nothing ever tells you *why* a memory came back.

This plugin puts [YantrikDB](https://github.com/yantrikos/yantrikdb-server)
behind OpenClaw's memory slot. YantrikDB is a memory database built for
agents: revision chains instead of overwrites, conflict detection, retrieval
explanations, and importance-weighted decay.

What that buys you in practice:

- **A briefing, not a dump.** At session start the plugin injects YantrikDB's
  session digest: open decisions, unresolved conflicts, pending triggers,
  known unknowns — bounded to ~2.4 KB by default, not your whole history.
- **Recall that shows its work.** Every `memory_recall` hit carries the
  server's retrieval reasons, and hits the engine considers stale, superseded,
  or disputed are flagged `[verify: may be stale or disputed]` instead of
  being presented as truth.
- **Capture that survives the session.** New user messages are stored as
  low-importance episodic memories during the session, and at session end the
  transcript summary is handed to the engine, which segments it into atomic,
  provisional facts server-side.
- **One memory across all your agents.** The same YantrikDB instance serves
  Claude Code, Cursor, and any MCP client through
  [yantrikdb-mcp](https://pypi.org/project/yantrikdb-mcp/). Your OpenClaw
  agent and your editor agent stop keeping separate diaries.

## Install (60 seconds)

1. Run a YantrikDB server (install options in the
   [yantrikdb-server README](https://github.com/yantrikos/yantrikdb-server)).
   The HTTP gateway listens on port `7438` by default.

2. Install the plugin:

   ```bash
   openclaw plugins install npm:@yantrikos/openclaw-memory-yantrikdb
   ```

3. Point the memory slot at it and configure the connection:

   ```jsonc
   {
     "plugins": {
       "slots": { "memory": "memory-yantrikdb" },
       "entries": {
         "memory-yantrikdb": {
           "config": {
             "baseUrl": "http://127.0.0.1:7438",
             "apiKey": "your-gateway-token"
           }
         }
       }
     }
   }
   ```

`baseUrl` and `apiKey` also fall back to the `YANTRIKDB_URL` and
`YANTRIKDB_API_KEY` environment variables.

## Tools

| Tool | What it does |
|---|---|
| `memory_recall` | Semantic search with retrieval reasons and stale/disputed flags. Superseded revisions are excluded by default (current-value-by-default). |
| `memory_store` | Save a durable fact with importance, type (`semantic` / `episodic` / `procedural`), and domain tag. Text is secret-redacted before storage. |
| `memory_forget` | Delete one memory by id. Recorded as a tombstone with your reason, not a silent hard delete. |

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:7438` | YantrikDB HTTP gateway URL |
| `apiKey` | — | Bearer token for the gateway |
| `namespace` | `openclaw` | Scopes this agent's memories inside the DB |
| `domain` | `general` | Default domain tag for stored memories |
| `autoRecall` | `true` | Inject the session-digest briefing at prompt build |
| `autoCapture` | `true` | Capture conversation facts automatically |
| `injectSessionDigest` | `true` | Use the digest (vs. nothing) as the boot briefing |
| `recallLimit` | `5` | Default result count for `memory_recall` |
| `timeoutMs` | `4000` | Per-request timeout; memory being slow never blocks the agent past this |
| `captureImportance` | `0.4` | Importance assigned to auto-captured memories |
| `maxContextChars` | `2400` | Hard cap on injected briefing size |

## What gets stored, exactly

With `autoCapture` on:

- user messages ≥ 24 characters, at most 4 per agent run, stored as
  episodic memories at importance 0.4;
- a bounded session summary at session end, which the server segments into
  provisional facts.

Before anything is persisted it passes a sanitization pipeline: ANSI/control
stripping, secret redaction (bearer tokens, AWS/GitHub/Slack/OpenAI-style
keys, PEM blocks, `key=value` assignments), and length clamping. Incognito
sessions are never captured and never receive injected memory context. Set
`autoCapture: false` to store nothing except explicit `memory_store` calls.

Deletion is first-class: `memory_forget` tombstones a memory with a reason,
and the same record is queryable/correctable from every other client of the
same YantrikDB instance.

## Security posture

Built to be auditable by scanner and human alike:

- **No subprocesses, no filesystem access, no eval.** The entire plugin is
  TypeScript talking HTTP via `fetch` to the one host you configure.
- **One runtime dependency** (`typebox`, for parameter schemas).
- **Injected memories are hedged.** Every recall result and briefing carries
  an explicit instruction to treat memory content as untrusted historical
  data, mirroring the convention of the in-tree memory plugins.
- **Fail-open.** If YantrikDB is unreachable, tools return a one-line
  unavailability notice and hooks return nothing; the agent keeps working.

## When you would not use this

If Markdown-file memory is working for you, keep it — the built-in
`memory-core` is simpler, has no server to run, and its hybrid search is
solid. This plugin earns its keep when you want memory that survives
contradiction (conflict detection), spans multiple agents/tools (shared
substrate over MCP + HTTP), or needs revision history instead of overwrites.

## Development

```bash
npm install
npm run build    # tsc → dist/
npm test         # tsc → dist-test/ + node --test (37 tests)
```

The `openclaw/plugin-sdk/*` modules are provided by the OpenClaw host at
runtime; `types/openclaw-plugin-sdk.d.ts` carries minimal structural
declarations so the package typechecks and tests standalone.

## License

MIT. The YantrikDB server is licensed separately — see
[yantrikos/yantrikdb-server](https://github.com/yantrikos/yantrikdb-server).

Built by [Pranab Sarkar](https://pranab.co.in).

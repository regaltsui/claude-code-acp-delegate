# DESIGN: Claude Code ACP Delegate Plugin

## 1. Purpose

Inside a Claude Code session, allow the master agent to delegate self-contained subtasks to any agent that speaks the Agent Client Protocol (ACP). The master stays on its primary provider; the ACP agent is a callable worker that returns text.

This plugin is the Claude Code native counterpart to `opencode-acp-delegate`. Where that plugin hooks into opencode's TypeScript plugin loader, this plugin exposes delegation tools as an MCP server — the canonical extension mechanism for Claude Code. Any conforming ACP agent — `gemini --acp`, `opencode acp`, `claude-agent-acp`, Codex, and others — can be registered and called without plugin-specific code per agent.

The master-worker shape is the same: each delegation is a self-contained subtask whose only output is text the master will read. The protocol is different from MCP itself: instead of driving the MCP server/tool lifecycle (which is handled by `@modelcontextprotocol/sdk`), the *ACP delegation inside* each tool call drives a separate JSON-RPC 2.0 session over stdio.

## 2. Why ACP

The Agent Client Protocol (https://agentclientprotocol.com) is an open, Apache-licensed standard created by Zed Industries in August 2025. It defines a JSON-RPC 2.0 message exchange over stdio for spawning and communicating with AI agents as subprocesses.

The alternative to ACP is per-agent CLI parsing: each agent has its own output format, its own flags, its own error codes. Adding a second agent would require a separate plugin with its own output parser, its own failure-mode table, its own test harness.

ACP gives a single integration point:

| Approach | Agents supported | Protocol | Maintenance cost |
|---|---|---|---|
| Per-agent CLI parsing | One per plugin | Proprietary stdout | High — each agent is a new plugin |
| ACP | Any conforming agent | JSON-RPC 2.0 over stdio | Low — one plugin, agent list is config |

The tradeoff: ACP requires the agent to support `--acp` or equivalent. Agents that only expose a headless CLI still need the per-agent approach. For agents that do support ACP, this plugin is the right integration.

Transport: JSON-RPC 2.0 over stdio (subprocess). The plugin ships a hand-rolled JSON-RPC client built on `node:child_process` and `node:readline` — no external ACP SDK dependency. This keeps the ACP client zero-dependency, consistent with the `opencode-acp-delegate` precedent.

## 3. Synchronous One-Shot Session Model

Each MCP tool call maps to exactly one ACP session lifecycle. The tool call is **synchronous**: it blocks until the agent subprocess completes, and returns the final text result directly. There is no persistent child process, no session reuse across calls, and no connection pool.

The lifecycle per call:

1. **Spawn** the agent subprocess with the configured command (e.g. `["gemini", "--acp"]`).
2. **Initialize** — send `initialize` with `clientCapabilities` and wait for `initializeResult`.
3. **New session** — send `session/new` and wait for `newSessionResult { sessionId }`.
4. **Prompt** — send `session/prompt` with the user's prompt text and the `sessionId`.
5. **Collect updates** — receive zero or more `session/update` notifications (streaming chunks). Accumulate text parts.
6. **Await result** — receive `promptResult { stopReason }`.
7. **Return to master** - The concatenated text is returned as the direct result of the MCP tool call.
8. **Close** — send `session/close` if the agent advertised that capability in `initializeResult`; otherwise skip.
9. **Kill** the subprocess.

Steps 1-9 happen within a single MCP `tools/call` handler. The subprocess is single-use and never reused.

Three parallel MCP tool calls in one master turn spawn three independent subprocesses. No coordination needed; the OS handles scheduling.

### 3.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code session (master agent)                              │
│                                                                 │
│   plans → tool call: delegate_to_gemini({ prompt, ... })        │
│   plans → tool call: delegate_to_claude(...) (parallel-safe)    │
│                          │                                      │
└──────────────────────────┼──────────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────┐
            │ MCP server: acp-delegate         │
            │ (dist/acp-server.js via .mcp.json)│
            │                                  │
            │   tool registry:                 │
            │     - delegate_to_gemini         │
            │     - delegate_to_claude         │
            │     - ...                        │
            │                                  │
            │   per-call:                      │
            │     spawn agent subprocess       │
            │     drive ACP session lifecycle  │
            │     await & return text          │
            └──────────────┬───────────────────┘
                           │  one subprocess per tool call
                           ▼
            ┌──────────────────────────────────┐
            │ ACP agent subprocess             │
            │                                  │
            │   e.g. gemini --acp              │
            │        opencode acp              │
            │        claude-agent-acp          │
            │                                  │
            │   JSON-RPC 2.0 over stdio        │
            └──────────────────────────────────┘
```

### 3.2 Claude Code plugin shape

The plugin is a standard Claude Code plugin directory with:

- `.claude-plugin/plugin.json` — plugin manifest (name, version, description).
- `.mcp.json` — declares the `acp-delegate` MCP server; Claude Code auto-starts it.
- `dist/acp-server.js` — pre-built, committed bundle (no runtime npm install needed).
- `hooks/hooks.json` — `SessionStart` hook to inject the optional routing block.
- `scripts/inject-guidance.sh` — shell script run by the SessionStart hook.
- `scripts/status-line.sh` — optional script for the user's `statusLine` setting.
- `skills/acp-doctor/SKILL.md` — skill invoked to show health + diagnostics.

The MCP server uses `@modelcontextprotocol/sdk`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server(
  { name: "acp-delegate", version: "0.1.0" },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...registry] }))
server.setRequestHandler(CallToolRequestSchema, async (req) => { /* drive ACP */ })
await server.connect(new StdioServerTransport())
```

Tools are described with zod schemas (for runtime arg validation) and JSON Schema (for `tools/list`). The `zod-to-json-schema` package converts the zod shape to the MCP-expected JSON Schema form. The MCP server is bundled to a single `dist/acp-server.js` via esbuild — no runtime `npm install` needed.

**Cancellation**: The MCP SDK does not surface a per-call AbortSignal from the transport. Instead, the server registers `SIGINT`/`SIGTERM` handlers that call `controller.abort()` on all in-flight `AbortController`s. The ACP client's `abortPromise` race leg fires and the delegation is cancelled via `session/cancel` + SIGTERM/SIGKILL.

**Tool result shape**: each tool returns `CallToolResult`:
```ts
{
  content: [{ type: "text", text: "<agent output>" }],
  isError: boolean,           // true when metadata.status === "error"
  _meta: { agentId, durationMs, status, stopReason?, errorCode? }
}
```

### 3.3 Per-call concerns

| Concern | Strategy |
|---|---|
| Hung subprocess | Per-call timeout (configurable). On timeout: SIGTERM, then SIGKILL after a grace period. |
| Concurrent calls | None needed. Each call is a separate subprocess. OS handles scheduling. |
| Stdout buffer | Bound to 8 MiB. Overflow drains with a truncation notice appended. |
| Subprocess orphaning | `detached: false` (default); subprocess dies if the MCP server dies. A `process.on('exit')` reaper SIGTERMs any in-flight subprocesses. |
| Error mapping | Translate `spawn ENOENT`, JSON-RPC errors, and ACP protocol errors into actionable messages returned synchronously from the tool call. |

## 4. v1 Limitations

These are explicit non-features in v1, not oversights.

| Limitation | Detail |
|---|---|
| Read-only filesystem | `clientCapabilities` is sent as `{ fs: { readTextFile: true } }`. Agents can read files but not write them, run shell commands, or call MCP servers. |
| No persistent sessions | Each tool call spawns a fresh subprocess and drives a complete session lifecycle from scratch. There is no session reuse, no warm subprocess pool, no continuity between calls. |
| One-shot only | A single tool call is a single `session/prompt` exchange. There is no multi-turn conversation within one tool call. The master agent is the one carrying conversational state across turns. |
| Text output only | v1 collects only text parts. Non-text parts (images, files, structured data) are ignored. |
| No streaming to master | Text chunks from `session/update` are accumulated internally and returned as a single string when `promptResult` arrives. |

## 5. Agent Registry Config

Agents are declared in a JSON file on disk. For each agent in the `agents` array, a tool named `delegate_to_<id>` is created.

Config file path resolution (first match wins):
1. `$CLAUDE_ACP_DELEGATE_CONFIG` (full path override)
2. `~/.config/claude/acp-delegate.json`
3. `~/.claude/acp-delegate.json`

```json
{
  "injectSystemGuidance": true,
  "agents": [
    { "id": "gemini",   "command": ["gemini", "--acp"] },
    { "id": "opencode", "command": ["opencode", "acp"] },
    { "id": "claude",   "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"] }
  ]
}
```

Field reference:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique identifier used to construct the tool name `delegate_to_<id>`. |
| `command` | string[] | yes | Argv to spawn. First element is the binary; remaining elements are args. |
| `label` | string | no | Human-readable label in auto-generated tool description. Defaults to `id`. |
| `timeout` | number | no | Per-agent timeout override in milliseconds. Defaults to 600000 (10 minutes). |
| `description` | string | no | Hand-tuned tool description shown to the master LLM. Plugin appends a capability footer. |
| `whenToUse` | string | no | One-line specialty summary used in the system-prompt routing block. |
| `models` | string[] | no | Model allowlist. When non-empty, adds a closed `model` enum arg to the tool. |
| `defaultModel` | string | no | Used when the `model` arg is omitted. Must be in `models` if both are set. |
| `modelFlag` | string | no | CLI flag used to pass the model to the agent. Defaults to `--model`. |

Top-level:

| Field | Type | Required | Notes |
|---|---|---|---|
| `injectSystemGuidance` | boolean | no | When `true`, the `SessionStart` hook emits the `<acp-delegate-routing>` block as session context. Default `false`. |

The schema for each generated tool (e.g., `delegate_to_gemini`):

| Param | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | Self-contained instruction. The agent has no prior session context. |
| `includeContext` | string[] | no | Relative paths under the project cwd. Eagerly read and prepended as `<context>` blocks (64 KiB/file, 256 KiB total). |
| `directory` | string | no | Override the project cwd for file resolution. Must be absolute. Defaults to MCP server cwd. |
| `model` | string (enum) | no | Only present when `models: [...]` is configured. |

## 6. ACP Protocol Flow

```
Client (plugin)              Agent (subprocess)
─────────────               ──────────────────
spawn ["gemini", "--acp"]
                         ─► stdin/stdout connected
initialize ─────────────►
  clientCapabilities: { fs: { readTextFile: true } }
                         ◄─ initializeResponse
                              agentCapabilities.sessionCapabilities.close?
session/new ────────────►
                         ◄─ newSessionResponse { sessionId }
session/prompt ─────────►
  sessionId, prompt text
                         ◄─ session/update (streaming chunk)
                              parts: [{ type: "text", text: "..." }]
                         ◄─ session/update ...
                         ◄─ promptResponse { stopReason }
[session/close] ────────►   (only if agentCapabilities.sessionCapabilities.close is truthy)
kill process
```

### 6.1 stopReason handling

| stopReason | status | Treatment |
|---|---|---|
| `end_turn` | `complete` | Output returned as-is; no trailer. |
| `max_tokens` | `complete` | Output returned with trailer `[delegate_to_<id>: stopReason=max_tokens, durationMs=…]`. |
| `max_turn_requests` | `complete` | Same as `max_tokens`. |
| `refusal` | `error` | Output replaced with refusal notice; `isError: true` in `CallToolResult`. |
| `cancelled` | `cancelled` | Output replaced with cancellation notice. |

### 6.2 Cancellation

When the MCP server receives SIGINT or SIGTERM, the server:

1. Calls `controller.abort()` on all in-flight `AbortController`s.
2. Sends `session/cancel` notification (best-effort, fire-and-forget).
3. Sends SIGTERM to the subprocess immediately after.
4. After `GRACE_PERIOD_MS = 5_000`, sends SIGKILL if the process is still alive.

### 6.3 Graceful close

In the success path the plugin attempts `session/close` only when `initializeResponse.agentCapabilities.sessionCapabilities.close` is truthy. The close request is bounded by a 1-second timeout; on timeout or error the subprocess is killed normally.

## 7. Future Roadmap

| Item | Status | Description |
|---|---|---|
| Per-agent timeout config | ✅ v0.1 | `timeout` is honored per agent entry in the registry. |
| Health check on startup | ✅ v0.1 | `probeAll(registry)` is fired (not awaited) at server start and result persisted to `state.json:health[]`. The `acp-doctor` skill reads this. |
| Eager context inclusion | ✅ v0.1 | The `includeContext` schema field reads files in-process and injects a fenced preamble. |
| Capability negotiation | Deferred | Let callers opt into more capabilities per call (e.g. `fs.writeTextFile`). |
| Streaming to master | Deferred | Surface `session/update` chunks incrementally via MCP progress notifications. |
| Non-text parts | Deferred | Handle image and structured-data parts from `session/update`. |
| Persistent subprocess pool | Deferred | Keep one warm subprocess per agent ID across calls to eliminate cold-start latency. |
| Multi-turn within a call | Deferred | Allow the master to pass a conversation history rather than a single prompt. |

## 8. Failure Modes

| Failure | Detection | Response |
|---|---|---|
| Agent binary not on PATH | `spawn ENOENT` | Return error synchronously: "Agent `<id>` command `<binary>` not found..." |
| ACP initialize timeout | No `initializeResponse` within timeout | Kill subprocess; return timeout error message synchronously. |
| JSON-RPC error response | Error object in response | Return error message synchronously; `isError: true`. |
| Subprocess exits before promptResponse | Exit event before `promptResponse` | Return error with exit code and stderr tail synchronously. |
| `promptResponse.stopReason: refusal` | Inspected after `prompt()` resolves | Replace `output` with refusal notice; `isError: true`. |
| `promptResponse.stopReason: max_tokens` | Inspected after `prompt()` resolves | Output preserved with `[delegate_to_<id>: stopReason=…]` trailer. |
| Stdout buffer overflow | Buffer exceeds `MAX_OUTPUT_BYTES = 8 MiB` | Output is truncated with a `[output truncated at N bytes]` notice. |
| Per-call timeout | Wall-clock timeout fires | SIGTERM subprocess; SIGKILL after grace period; return timeout error synchronously. |
| MCP server SIGINT/SIGTERM | Signal received | Abort all in-flight `AbortController`s; delegations receive ECANCELLED. |

## 9. References

- Agent Client Protocol spec: https://agentclientprotocol.com
- Claude Code plugin docs: https://docs.anthropic.com/en/docs/claude-code/plugins
- Claude Code MCP docs: https://docs.anthropic.com/en/docs/claude-code/mcp
- Claude Code hooks docs: https://docs.anthropic.com/en/docs/claude-code/hooks
- `@modelcontextprotocol/sdk`: https://www.npmjs.com/package/@modelcontextprotocol/sdk
- Reference plugin: https://github.com/regaltsui/opencode-acp-delegate

## 10. State file & cross-process integration

The MCP server persists runtime state to a JSON file so the `acp-doctor` skill and the optional `status-line.sh` script can observe what is currently running.

### Path resolution

First match wins:

1. `$CLAUDE_ACP_DELEGATE_STATE_DIR` — full directory path override.
2. `$XDG_STATE_HOME/claude/acp-delegate` — XDG Base Directory spec.
3. `~/.local/state/claude/acp-delegate` — default.

Files inside the state directory:

| File | Purpose |
|---|---|
| `state.json` | Atomically-replaced snapshot of inflight + recent + health entries. |
| `usage.jsonl` | Append-only one-line-per-event usage log. Rotates at 5 MiB. |

### Schema

```ts
interface AcpState {
  version: 1
  updatedAt: number
  pid: number
  inflight: InflightEntry[]   // currently running
  recent: RecentEntry[]       // capped at 20, most recent first
  health: HealthEntry[]       // last probe per registered agent
}
```

### Atomic write protocol

Every mutation goes through a single module-level `writeQueue` promise chain to serialise writes. Each save is:

1. Serialise to temp file `state.json.<pid>.<rand>.tmp`.
2. `rename(tmp, "state.json")` — atomic on POSIX.
3. On any error during write/rename, attempt to unlink the temp file and re-throw.

State writes are **best-effort** — a broken state directory cannot break delegation.

### Health probe

At server start, every registered agent is probed in parallel via `probeAll()`:
- Spawn the agent's `command`.
- Send `initialize` over JSON-RPC, race against a 5-second timer.
- Always kill the child in `finally`. Never throws.

## 11. Claude Code adapter surfaces

### statusLine script (user opt-in)

Claude Code plugins cannot register a `statusLine` — only user settings (`~/.claude/settings.json`) can. The plugin ships `scripts/status-line.sh` which reads `state.json` and prints one line:

```
acp: 2 inflight (gemini 12s, claude 4s)
```

To enable:
```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/claude-code-acp-delegate/scripts/status-line.sh"
  }
}
```

Note: `${CLAUDE_PLUGIN_ROOT}` is NOT expanded in user-level `~/.claude/settings.json`; you must use the absolute path. See `examples/settings-snippet.json`.

### /acp-doctor skill

The plugin ships `skills/acp-doctor/SKILL.md`. Claude Code auto-discovers this skill. When invoked (either explicitly via `/claude-code-acp-delegate:acp-doctor` or conversationally by asking about agent health), Claude reads `state.json` using its `Read` tool and formats the health/inflight/recent data.

### SessionStart hook (system guidance injection)

When `injectSystemGuidance: true` in the config, the `hooks/hooks.json` `SessionStart` hook runs `scripts/inject-guidance.sh` once per session. The script reads the config, builds an `<acp-delegate-routing>` block listing each registered tool with its one-line specialty, and prints it to stdout. Claude Code adds this stdout as session context visible to the master agent.

This replaces opencode's `experimental.chat.system.transform` hook.

## 12. Tool result shape

Every `delegate_to_<id>` tool returns a `CallToolResult`:

```ts
{
  content: [{ type: "text", text: string }],
  isError: boolean,
  _meta: {
    agentId: string
    durationMs: number
    status: "complete" | "error" | "cancelled"
    stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
    errorCode?: string  // ENOENT, ETIMEDOUT, ECANCELLED, EAGENT, …
  }
}
```

### Two channels, two audiences

| Channel | Audience | What lives here |
|---|---|---|
| `content[0].text` | The master LLM | The agent's full text response. Load-bearing flags (truncation) are embedded here as trailers because the LLM sees `content`, not `_meta`. |
| `_meta` | Structured telemetry | Machine-readable `agentId / durationMs / status / stopReason / errorCode`. |

### Load-bearing trailer

When `stopReason ∈ { max_tokens, max_turn_requests }`, the plugin appends to `content[0].text`:

```
[delegate_to_<id>: stopReason=max_tokens, durationMs=12453]
```

Errors do NOT throw — `execute` always returns a `CallToolResult`. Throwing would make the master agent give up rather than retry.

## 13. Claude Code plugin layout

```
claude-code-acp-delegate/
├── .claude-plugin/
│   └── plugin.json          # Plugin identity manifest
├── .mcp.json                # MCP server registration (spawns dist/acp-server.js)
├── src/
│   └── acp-server.ts        # TypeScript source (MCP server + inline ACP client)
├── dist/
│   └── acp-server.js        # Pre-built bundle (committed; no runtime npm install)
├── hooks/
│   └── hooks.json           # SessionStart hook registration
├── scripts/
│   ├── inject-guidance.sh   # SessionStart hook script (routing block emitter)
│   └── status-line.sh       # Optional statusLine script (user opt-in)
├── skills/
│   └── acp-doctor/
│       └── SKILL.md         # /acp-doctor skill for health diagnostics
├── examples/
│   ├── acp-delegate.json    # Example config file
│   └── settings-snippet.json # statusLine settings snippet
├── package.json             # Build scripts + dependencies
├── tsconfig.json            # TypeScript config
├── DESIGN.md                # This document
└── README.md                # User-facing install/configure/usage guide
```

## 14. Differences from `opencode-acp-delegate`

| Aspect | opencode-acp-delegate | claude-code-acp-delegate |
|---|---|---|
| Plugin runtime | opencode TypeScript plugin loader (`@opencode-ai/plugin`) | MCP stdio server (`@modelcontextprotocol/sdk`) |
| Tool registration | `tool({ description, args, execute })` API | `server.setRequestHandler(ListToolsRequestSchema, ...)` |
| Config | Plugin tuple options OR JSON file fallback | JSON file ONLY |
| Config env var | `OPENCODE_ACP_DELEGATE_CONFIG` | `CLAUDE_ACP_DELEGATE_CONFIG` |
| State env var | `OPENCODE_ACP_DELEGATE_STATE_DIR` | `CLAUDE_ACP_DELEGATE_STATE_DIR` |
| State directory | `~/.local/state/opencode/acp-delegate/` | `~/.local/state/claude/acp-delegate/` |
| System prompt injection | `experimental.chat.system.transform` hook | `SessionStart` hook (`hooks/hooks.json`) |
| In-flight badge | `@opentui/solid` `session_prompt_right` slot | `statusLine` script (user opt-in) |
| In-flight sidebar | `@opentui/solid` `sidebar_content` slot | `statusLine` script (multi-line variant) |
| `/acp-doctor` command | TUI `api.command.register` + `DialogAlert` | Skill (`skills/acp-doctor/SKILL.md`) |
| Distribution | Single `.ts` file OR GitHub URL tuple | Claude Code plugin directory + pre-built `dist/` |
| `ctx.directory` | From `ToolContext.directory` | `process.cwd()` at server start; overridable via `directory` tool arg |
| Session ID | From `ctx.sessionID` | Empty string (MCP has no equivalent) |

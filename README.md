# claude-code-acp-delegate

A Claude Code native plugin that exposes one `delegate_to_<id>` MCP tool per configured ACP-compatible coding agent. The master agent delegates self-contained subtasks to external agents (gemini, opencode, claude-agent-acp, Codex, or any ACP-speaking binary) and receives their text response synchronously.

The plugin is not tied to any specific agent — configure any ACP-compatible agent and it works the same way.

---

## Prerequisites

At least one ACP-compatible agent installed and on your PATH:

- **Google Gemini CLI** (`gemini --acp`):
  ```bash
  npm i -g @google/gemini-cli
  gemini   # walk through OAuth login once; quit with Ctrl-C when done
  ```
- **Opencode** (`opencode acp`): already available if you're running opencode. Authenticate once with `opencode auth login`.
- **Claude Code** via the official adapter `@agentclientprotocol/claude-agent-acp`. No global install required — invoke via `npx`. The adapter delegates to the `claude` CLI under the hood, so make sure `claude` is installed and authenticated:
  ```bash
  npm i -g @anthropic-ai/claude-code
  claude   # walk through login once; quit when done
  # the adapter itself will be downloaded by npx on first use
  ```
- **Codex and other conforming ACP agents**: configure the same way — the plugin only cares that the spawned binary speaks ACP over stdio.

---

## Installation

The plugin ships a pre-built `dist/acp-server.js` — no build step required after cloning.

### Developer install (local directory)

```bash
git clone https://github.com/regaltsui/claude-code-acp-delegate
claude --plugin-dir ./claude-code-acp-delegate
```

That's it. Claude Code loads the plugin from the local directory. Run `/reload-plugins` after making changes.

### Modifying the source

If you change `src/acp-server.ts`:

```bash
npm install
npm run build   # rebuilds dist/acp-server.js
```

Then restart Claude Code (or run `/reload-plugins` if MCP server changes are picked up).

### Marketplace install (when published)

```bash
/plugin install claude-code-acp-delegate
```

Then fully restart Claude Code.

---

## Configuration

Create a JSON config file at one of these paths (first match wins):

1. Path in `$CLAUDE_ACP_DELEGATE_CONFIG` environment variable
2. `~/.config/claude/acp-delegate.json`
3. `~/.claude/acp-delegate.json`

**Minimal config:**

```json
{
  "agents": [
    { "id": "gemini",   "command": ["gemini", "--acp"] },
    { "id": "opencode", "command": ["opencode", "acp"] },
    { "id": "claude",   "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"] }
  ]
}
```

**Full config with all options:**

```json
{
  "injectSystemGuidance": true,
  "agents": [
    {
      "id": "gemini",
      "command": ["gemini", "--acp"],
      "description": "Reach for delegate_to_gemini for bulk read-only analysis across many files (1M-token window) or a fast second opinion from an independent model family.",
      "whenToUse": "bulk multi-file analysis, fast second opinion",
      "models": ["gemini-2.5-pro", "gemini-2.5-flash"],
      "defaultModel": "gemini-2.5-flash",
      "modelFlag": "-m"
    },
    {
      "id": "claude",
      "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"],
      "description": "Reach for delegate_to_claude when you need deep design review, architecture critique, or careful refactoring analysis.",
      "whenToUse": "deep design review, architecture critique",
      "models": ["claude-opus-4-5", "claude-sonnet-4-5"],
      "defaultModel": "claude-sonnet-4-5"
    },
    {
      "id": "opencode",
      "command": ["opencode", "acp"],
      "whenToUse": "quick general-purpose delegation"
    }
  ]
}
```

See `examples/acp-delegate.json` for the full example file.

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier used to create the `delegate_to_<id>` tool. |
| `command` | string[] | yes | Argv to spawn. First element is the binary; remaining are args. Resolved from PATH. |
| `label` | string | no | Human-readable label in the auto-generated tool description. Defaults to `id`. |
| `timeout` | number | no | Per-agent timeout in milliseconds. Defaults to 600000 (10 minutes). |
| `description` | string | no | Hand-tuned tool description shown to the LLM. Plugin appends a capability footer. |
| `whenToUse` | string | no | One-line specialty summary for the system-prompt routing block. |
| `models` | string[] | no | Model allowlist. When set, the tool exposes a `model` enum arg. |
| `defaultModel` | string | no | Used when `model` is omitted. Must be in `models`. |
| `modelFlag` | string | no | CLI flag passed to the agent binary. Defaults to `--model`. |

Top-level options:

| Field | Type | Required | Description |
|---|---|---|---|
| `injectSystemGuidance` | boolean | no | When `true`, injects an `<acp-delegate-routing>` block at session start. Default `false`. |

---

## Usage

Once installed and configured, Claude Code gains a `delegate_to_<id>` MCP tool for each registered agent.

### Tool parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | Self-contained task. The agent has no prior context from the current session. |
| `includeContext` | string[] | no | Relative paths (files or directories). Eagerly read and prepended as `<context path="…">…</context>` blocks, capped at 256 KiB total / 64 KiB per file. Binary files and paths outside the project are skipped with a notice. |
| `directory` | string | no | Override the project directory for file resolution. Must be absolute. Defaults to the MCP server's cwd. |
| `model` | string | no | Only present when `models: [...]` is configured. Must be one of the declared model IDs. |

### Single delegation

```
> use delegate_to_gemini to summarize ./docs in 5 bullet points
```

The master calls the MCP tool, the gemini agent runs to completion, and the master receives the final text synchronously.

### Parallel fan-out

```
> In parallel, use delegate_to_gemini to summarize ./docs,
  use delegate_to_opencode to review ./src for obvious bugs,
  and use delegate_to_claude to explain what ./scripts does.
  Then combine into one report.
```

Three independent ACP subprocesses run concurrently.

### Tool result

```ts
{
  content: [{ type: "text", text: string }],   // what the master LLM sees
  isError: boolean,
  _meta: {
    agentId: string,
    durationMs: number,
    status: "complete" | "error" | "cancelled",
    stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled",
    errorCode?: string   // ENOENT, ETIMEDOUT, ECANCELLED, EAGENT, …
  }
}
```

When the agent reports `stopReason ∈ { max_tokens, max_turn_requests }`, the response gets a trailer appended to `content[0].text`:

```
[delegate_to_<id>: stopReason=max_tokens, durationMs=12453]
```

---

## Status line (optional, user opt-in)

Claude Code plugins cannot register a `statusLine` themselves — you must add it to your own `~/.claude/settings.json`. The plugin ships `scripts/status-line.sh` which shows a live count of in-flight delegations.

Add to your `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/claude-code-acp-delegate/scripts/status-line.sh"
  }
}
```

Replace the path with the absolute path to your clone. `${CLAUDE_PLUGIN_ROOT}` is NOT expanded in user-level settings — you must use the absolute path. See `examples/settings-snippet.json`.

When in-flight delegations are running, the status bar shows:
```
acp: 2 inflight (gemini 12s, claude 4s)
```

---

## /acp-doctor skill

The plugin includes `skills/acp-doctor/SKILL.md`. Claude Code auto-discovers this skill. Invoke it by asking about agent health:

```
> check delegate health
> is gemini working?
> run the acp-doctor skill
> /claude-code-acp-delegate:acp-doctor
```

Claude reads the state file and reports:
- Per-agent health probe results (✓/✗, response time, last checked)
- In-flight delegations (count + elapsed + prompt snippet)
- Recent failure rate (last 20 delegations)

---

## v1 Limitations

| Limitation | Detail |
|---|---|
| Read-only filesystem | Agents can read files (`fs.readTextFile`) but cannot write files, run shell commands, or call MCP servers. |
| No persistent sessions | Each tool call spawns a fresh agent subprocess. There is no session reuse or warm subprocess pool. |
| One-shot only | A single tool call is a single prompt exchange. No multi-turn conversation within one call. |
| Text output only | Image and structured-data parts from agents are ignored in v1. |

---

## State files

The MCP server writes runtime state to:

| File | Purpose |
|---|---|
| `<stateDir>/state.json` | In-flight delegations, recent history (capped at 20), and last health-probe results. Atomically replaced on every lifecycle event. |
| `<stateDir>/usage.jsonl` | Append-only per-completion log. Auto-rotates to `usage.jsonl.1` once the live log exceeds 5 MiB. |

Path resolution (first match wins):

1. `$CLAUDE_ACP_DELEGATE_STATE_DIR` (full path override)
2. `$XDG_STATE_HOME/claude/acp-delegate`
3. `~/.local/state/claude/acp-delegate` (default)

---

## Troubleshooting

**MCP tool not appearing in Claude Code** — Check that `dist/acp-server.js` exists (if it doesn't, run `npm install && npm run build`). Check that `.mcp.json` is at the plugin root. Fully restart Claude Code after changing plugin files.

**"Plugin config must include a non-empty 'agents' array..."** — No config file was found. Create one at `~/.config/claude/acp-delegate.json` or set `$CLAUDE_ACP_DELEGATE_CONFIG` to your config file path.

**"Agent binary not found"** — The binary in `command[0]` isn't on PATH. Verify with `which gemini` (or whichever binary) and install if missing.

**Timeout** — The default timeout is 600 seconds. If a task is too large, split it or increase `timeout` in your agent config (value in milliseconds).

**Status line empty** — Verify: (1) `statusLine` is in your `~/.claude/settings.json` with an **absolute** path to `scripts/status-line.sh`, (2) the script is executable (`chmod 755 scripts/status-line.sh`), (3) the MCP server has run at least one delegation (which creates `state.json`).

**SessionStart hook not running / routing block not appearing** — Check that `hooks/hooks.json` is at the plugin root (not inside `.claude-plugin/`), and that `scripts/inject-guidance.sh` is executable. Also verify `injectSystemGuidance: true` is set in your config file.

**`/claude-code-acp-delegate:acp-doctor` not found** — Run `/reload-plugins` to ensure the skill was discovered. The skill directory must be `skills/acp-doctor/SKILL.md` at the plugin root.

---

## Migrating from `opencode-acp-delegate`

If you were using the opencode plugin, the config file format is identical — only the paths and env var names changed:

| Setting | opencode | claude-code |
|---|---|---|
| Config env var | `OPENCODE_ACP_DELEGATE_CONFIG` | `CLAUDE_ACP_DELEGATE_CONFIG` |
| State dir env var | `OPENCODE_ACP_DELEGATE_STATE_DIR` | `CLAUDE_ACP_DELEGATE_STATE_DIR` |
| Default config | `~/.config/opencode/acp-delegate.json` | `~/.config/claude/acp-delegate.json` |
| Fallback config | `~/.opencode/acp-delegate.json` | `~/.claude/acp-delegate.json` |
| State directory | `~/.local/state/opencode/acp-delegate/` | `~/.local/state/claude/acp-delegate/` |

Copy your existing `acp-delegate.json` to the new path and you're done.

---

## License

MIT

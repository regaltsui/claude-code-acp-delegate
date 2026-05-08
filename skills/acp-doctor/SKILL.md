---
name: acp-doctor
description: Diagnose ACP delegate health by reading state.json. Use when the user asks about delegate connectivity, agent health, in-flight delegations, recent failures, or whether gemini/opencode/claude is working.
---

Read the ACP delegate state file and report agent health, in-flight delegations, and recent failure patterns.

## State file path resolution

Resolve in this order (use the first readable path):
1. `$CLAUDE_ACP_DELEGATE_STATE_DIR/state.json`
2. `$XDG_STATE_HOME/claude/acp-delegate/state.json`
3. `$HOME/.local/state/claude/acp-delegate/state.json`

**Use the `Read` tool to load the file.** Do not use Bash, cat, or jq.

If the file does not exist, report: "No state file found. The ACP delegate MCP server may not have started yet, or no delegations have been attempted."

## State file schema

```typescript
interface StateFile {
  version: number
  updatedAt: number       // ms epoch — when state was last written
  pid: number             // PID of the MCP server process
  inflight: InflightEntry[]
  recent: RecentEntry[]
  health: HealthEntry[]
}

interface InflightEntry {
  callId: string
  sessionId: string       // empty string in Claude Code context
  agentId: string
  promptSnippet: string   // first 80 chars of prompt
  startedAt: number       // ms epoch
}

interface HealthEntry {
  agentId: string
  ok: boolean
  durationMs: number
  checkedAt: number       // ms epoch
  error?: string          // present when ok=false
}

interface RecentEntry extends InflightEntry {
  status: "complete" | "error" | "cancelled"
  endedAt: number         // ms epoch
  durationMs: number
  errorCode?: string      // ENOENT, ETIMEDOUT, ECANCELLED, EAGENT, …
}
```

## Required output sections

### Per-agent health

One row per `health[]` entry. If empty: "(no health data — probes run at server startup and may not have completed yet)".

| Agent | Status | Response | Last checked | Error |
|-------|--------|----------|--------------|-------|

- Convert `checkedAt` ms epoch to relative time ("just now", "3m ago", "1h ago").
- ✓ for `ok: true`, ✗ for `ok: false`.
- Include `error` value when `ok` is false.

### In-flight delegations

Count of `inflight[]`. If empty: "0 in-flight".

If non-empty, list each entry:
- Agent ID, elapsed time since `startedAt` (convert ms to seconds/minutes), first ~60 chars of `promptSnippet`.

### Recent failure rate

From `recent[]`:
- Total entries, count where `status !== "complete"`.
- Show up to 3 most recent non-complete entries: agentId, status, errorCode, how long ago (from `endedAt`).
- Summary line: "N failures in last M recent delegations" — or "0 failures" if clean.

## Formatting rules

- Use terse markdown (tables or short bullets).
- Convert ALL ms epoch values to human-readable relative time. Never show raw epoch numbers.
- Only emojis: ✓ (healthy) and ✗ (failed).
- If `recent[]` is empty: "(no recent delegation history)".

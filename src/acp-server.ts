/**
 * claude-code-acp-delegate — ACP delegation MCP server for Claude Code
 *
 * Registers one tool per configured ACP agent: `delegate_to_<id>`. Each tool
 * spawns a fresh subprocess (`gemini --acp`, `opencode acp`,
 * `npx @agentclientprotocol/claude-agent-acp`, …), drives a one-shot ACP
 * session over stdio, and returns the agent's final text response.
 *
 * CONFIGURATION: Set $CLAUDE_ACP_DELEGATE_CONFIG to a JSON file path, or drop
 * a JSON file at one of:
 *   ~/.config/claude/acp-delegate.json
 *   ~/.claude/acp-delegate.json
 *
 * Example JSON:
 *   {
 *     "agents": [
 *       { "id": "gemini",   "command": ["gemini", "--acp"] },
 *       { "id": "opencode", "command": ["opencode", "acp"] },
 *       { "id": "claude",   "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"] }
 *     ]
 *   }
 *
 * SOURCE: https://github.com/regaltsui/claude-code-acp-delegate
 */

// ============================================================================
// Imports
// ============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import {
  type ToolSpec,
  type TriggerContext,
  CLAUDE_NAMESPACE,
  buildToolRegistration,
  loadConfig,
  recordHealth,
  probeAll,
} from "@regaltsui/acp-delegate"

// ============================================================================
// MCP server identity
// ============================================================================

const SERVER_NAME = "acp-delegate"
const SERVER_VERSION = "0.1.0"
const PROJECT_CWD = process.cwd()

// ============================================================================
// Tool registry + inflight abort tracking
// ============================================================================

interface RegisteredTool {
  name: string
  description: string
  /** JSON Schema object derived from the core's ToolArgSchema. */
  inputSchema: object
  execute: (
    args: Record<string, unknown>,
    ctx: TriggerContext,
  ) => Promise<{ output: string; metadata: Record<string, unknown> }>
}

const registry: RegisteredTool[] = []
function registerTool(t: RegisteredTool): void {
  if (registry.some((r) => r.name === t.name)) {
    throw new Error(`Duplicate tool name: ${t.name}`)
  }
  registry.push(t)
}
const inflightControllers: Set<AbortController> = new Set()

// ============================================================================
// ToolArgSchema → MCP JSON Schema converter
// ============================================================================

/**
 * Convert a core ToolArgSchema into a JSON Schema object suitable for the
 * MCP SDK's `inputSchema` field on Tool objects.
 */
function toolArgSchemaToJsonSchema(schema: ToolSpec["args"]): object {
  const properties: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.type === "string") {
      const entry: Record<string, unknown> = {
        type: "string",
        description: field.description,
      }
      if (field.enum !== undefined) entry.enum = field.enum
      if (field.minLength !== undefined) entry.minLength = field.minLength
      properties[key] = entry
    } else if (field.type === "array") {
      properties[key] = {
        type: "array",
        description: field.description,
        items: {
          type: field.items.type,
          ...(field.items.minLength !== undefined
            ? { minLength: field.items.minLength }
            : {}),
        },
      }
    }
  }
  return {
    type: "object",
    properties,
    ...(schema.required !== undefined && schema.required.length > 0
      ? { required: schema.required }
      : {}),
  }
}

// ============================================================================
// MCP Server — ListTools + CallTool handlers
// ============================================================================

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: registry.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Tool["inputSchema"],
  })),
}))

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

server.setRequestHandler(
  CallToolRequestSchema,
  async (req): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = req.params
    const tool = registry.find((t) => t.name === name)
    if (!tool) return errorResult(`Unknown tool: ${name}`)
    const controller = new AbortController()
    inflightControllers.add(controller)
    const ctx: TriggerContext = {
      directory: PROJECT_CWD,
      abort: controller.signal,
    }
    try {
      const result = await tool.execute(rawArgs as Record<string, unknown>, ctx)
      const isError = result.metadata?.["status"] === "error"
      return {
        content: [{ type: "text", text: result.output }],
        isError,
        _meta: result.metadata,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult(`${name} crashed: ${msg}`)
    } finally {
      inflightControllers.delete(controller)
    }
  },
)

// ============================================================================
// Tool registration from core's buildToolRegistration
// ============================================================================

function registerToolSpecs(specs: ToolSpec[]): void {
  for (const spec of specs) {
    registerTool({
      name: spec.name,
      description: spec.description,
      inputSchema: toolArgSchemaToJsonSchema(spec.args),
      execute: spec.execute,
    })
  }
}

// ============================================================================
// Entry point
// ============================================================================

async function main(): Promise<void> {
  // injectSystemGuidance is intentionally ignored: the MCP server has no
  // mechanism to inject context into the host's system prompt. Only the
  // session-start hook (scripts/inject-guidance.sh) can act on it.
  const { agents } = loadConfig(CLAUDE_NAMESPACE)
  const specs = buildToolRegistration(agents, CLAUDE_NAMESPACE)
  registerToolSpecs(specs)
  void probeAll(agents)
    .then((health) => recordHealth(CLAUDE_NAMESPACE, health).catch((err: unknown) => { process.stderr.write(`acp-delegate: recordHealth failed: ${String(err)}\n`) }))
    .catch((err: unknown) => {
      process.stderr.write(
        `acp-delegate: health probe failed: ${String(err)}\n`,
      )
    })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  for (const controller of inflightControllers) {
    try {
      controller.abort()
    } catch (err: unknown) {
      process.stderr.write(`acp-delegate: abort error: ${String(err)}\n`)
    }
  }
  setTimeout(() => {
    process.exit(signal === "SIGINT" ? 130 : 143)
  }, 200).unref()
}

process.once("SIGINT", () => {
  shutdown("SIGINT")
})
process.once("SIGTERM", () => {
  shutdown("SIGTERM")
})

main().catch((err: unknown) => {
  process.stderr.write(
    `acp-delegate fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})
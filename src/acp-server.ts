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
import { z } from "zod"
import { zodToJsonSchema as zodToJsonSchemaImpl } from "zod-to-json-schema"
import {
  type AgentConfig,
  type ComplexityTier,
  type HostAdapter,
  type RunDelegationArgs,
  CLAUDE_NAMESPACE,
  COMPLEXITY_TIERS,
  INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES,
  INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES,
  runDelegation,
  loadConfig,
  recordHealth,
  probeAll,
  sanitizeToolSuffix,
  describeAgent,
} from "@regaltsui/acp-delegate"

// ============================================================================
// MCP server identity + MCP layer types
// ============================================================================

const SERVER_NAME = "acp-delegate"
const SERVER_VERSION = "0.1.0"
const PROJECT_CWD = process.cwd()

interface ToolContext {
  directory: string
  abort?: AbortSignal
}

interface RegisteredTool {
  name: string
  description: string
  inputSchema: z.ZodObject<z.ZodRawShape>
  jsonSchema: object
  execute: (
    args: unknown,
    ctx: ToolContext,
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
// JSON Schema converter
// ============================================================================

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): object {
  return zodToJsonSchemaImpl(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as object
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
    inputSchema: t.jsonSchema as Tool["inputSchema"],
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
    const parsed = tool.inputSchema.safeParse(rawArgs ?? {})
    if (!parsed.success)
      return errorResult(
        `Invalid arguments for ${name}: ${parsed.error.message}`,
      )
    const controller = new AbortController()
    inflightControllers.add(controller)
    const ctx: ToolContext = {
      directory: PROJECT_CWD,
      abort: controller.signal,
    }
    try {
      const result = await tool.execute(parsed.data, ctx)
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
// Tool argument schemas
// ============================================================================

const PROMPT_ARG = z
  .string()
  .min(1)
  .describe(
    "Self-contained task prompt. The agent has zero prior context; include all goals, " +
      "constraints, and the desired output format inline.",
  )

const INCLUDE_CONTEXT_ARG = z
  .array(z.string().min(1))
  .optional()
  .describe(
    "Optional. Relative paths under the project cwd (files or directories). Their contents " +
      "are eagerly read and prepended to the prompt as <context path=\"…\"> blocks, capped at " +
      `${INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES / 1024} KiB total / ${INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES / 1024} KiB per file. ` +
      "Binary files and paths outside the project are skipped with a notice.",
  )

const DIRECTORY_ARG = z
  .string()
  .optional()
  .describe(
    "Override the project directory used for includeContext and file resolution. " +
      "Must be an absolute path. Defaults to the MCP server's working directory.",
  )

// ============================================================================
// Tool factory — one RegisteredTool per AgentConfig
// ============================================================================

function makeDelegateTool(agent: AgentConfig, agents: AgentConfig[]): RegisteredTool {
  const name = `delegate_to_${sanitizeToolSuffix(agent.id)}`
  const description = describeAgent(agent)

  // Resolve which complexity tiers this agent has explicitly mapped models for.
  const populatedTiers: ComplexityTier[] =
    agent.complexityModels !== undefined
      ? COMPLEXITY_TIERS.filter((t) => {
          const v = agent.complexityModels?.[t]
          return typeof v === "string" && v.length > 0
        })
      : []
  const hasComplexity = populatedTiers.length > 0
  const hasModels = agent.models !== undefined && agent.models.length > 0

  const extraFields: z.ZodRawShape = {}

  if (hasModels) {
    extraFields["model"] = z
      .enum(agent.models as [string, ...string[]])
      .optional()
      .describe(
        `Optional. Model id passed to the agent via '${agent.modelFlag ?? "--model"}'. ` +
          `Allowed values: ${agent.models!.join(", ")}. ` +
          (agent.defaultModel !== undefined
            ? `Defaults to '${agent.defaultModel}' when omitted.`
            : "Omit to use the agent's built-in default."),
      )
  }

  if (hasComplexity) {
    extraFields["complexity"] = z
      .enum(populatedTiers as [ComplexityTier, ...ComplexityTier[]])
      .optional()
      .describe(
        "Optional. Complexity tier that selects a model via the agent's complexity routing map. " +
          "Ignored when 'model' is also supplied ('model' takes precedence). " +
          `Tiers: ${populatedTiers.map((t) => `${t} → ${agent.complexityModels![t]}`).join(", ")}.`,
      )
  }

  const inputSchema = z.object({
    prompt: PROMPT_ARG,
    includeContext: INCLUDE_CONTEXT_ARG,
    directory: DIRECTORY_ARG,
    ...extraFields,
  })

  const jsonSchema = zodToJsonSchema(inputSchema)

  return {
    name,
    description,
    inputSchema,
    jsonSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
      const typedArgs = args as RunDelegationArgs
      const host: HostAdapter = {
        getDirectory: ({ directoryArg }) =>
          directoryArg ?? ctx.directory ?? PROJECT_CWD,
        getSessionId: () => "",
        getAbortSignal: () => ctx.abort ?? new AbortController().signal,
        namespace: CLAUDE_NAMESPACE,
      }
      // Pass the full agents registry so upstream's retry/fallback loop is active.
      return runDelegation(agent, typedArgs, host, undefined, agents)
    },
  }
}

// ============================================================================
// Entry point
// ============================================================================

async function main(): Promise<void> {
  const config = loadConfig(CLAUDE_NAMESPACE)
  for (const agent of config.agents) {
    registerTool(makeDelegateTool(agent, config.agents))
  }
  void probeAll(config.agents)
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

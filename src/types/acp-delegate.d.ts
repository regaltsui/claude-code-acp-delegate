/**
 * Hand-written type stub for @regaltsui/acp-delegate.
 *
 * This file exists to prevent tsc from type-checking the raw .ts source files
 * inside node_modules/@regaltsui/acp-delegate (which contain type errors under
 * noUncheckedIndexedAccess that are not present in this project's own code).
 *
 * ONLY declares the symbols imported by src/acp-server.ts. This is a fallback
 * as described in TASK.md T4 remediation #3.
 */

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  id: string
  command: string[]
  default?: boolean
  timeout?: number
  label?: string
  description?: string
  whenToUse?: string
  models?: string[]
  defaultModel?: string
  complexityModels?: { high?: string; mid?: string; low?: string }
  modelFlag?: string
  autoApprove?: boolean
}

export const COMPLEXITY_TIERS: readonly ["high", "mid", "low"]
export type ComplexityTier = "high" | "mid" | "low"

export interface RunDelegationArgs {
  prompt: string
  includeContext?: string[]
  model?: string
  complexity?: ComplexityTier
  directory?: string
  retryAttempts?: number
}

export interface Namespace {
  configDirSubpath: string
  envPrefix: string
}

export interface HostAdapter {
  getDirectory(args: { directoryArg?: string }): string
  getSessionId(): string
  getAbortSignal(): AbortSignal
  reportProgress?(metadata: Record<string, unknown>): void
  namespace: Namespace
}

// ============================================================================
// Constants
// ============================================================================

export const CLAUDE_NAMESPACE: Namespace
export const INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES: number
export const INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES: number

// ============================================================================
// Functions
// ============================================================================

export function runDelegation(
  agent: AgentConfig,
  args: RunDelegationArgs,
  host: HostAdapter,
  pool?: unknown | null,
  agents?: AgentConfig[],
): Promise<{ output: string; metadata: Record<string, unknown> }>

export function loadConfig(namespace: Namespace): {
  agents: AgentConfig[]
  injectSystemGuidance: boolean
}

export interface HealthEntry {
  agentId: string
  ok: boolean
  durationMs: number
  checkedAt: number
  error?: string
}

export function recordHealth(
  namespace: Namespace,
  health: HealthEntry[],
): Promise<void>

export function probeAll(agentRegistry: AgentConfig[]): Promise<HealthEntry[]>

export function sanitizeToolSuffix(id: string): string

export function describeAgent(agent: AgentConfig): string

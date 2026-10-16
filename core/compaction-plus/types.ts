import type { NexusConfigSource } from "../nexus-config.ts"

/**
 * nexus-compaction-plus core types (core module), runtime-agnostic.
 */

export interface NexusState {
  sessionId?: string
  sessionTitle?: string
  projectId?: string
  agentId?: string
}

export interface NexusConfig {
  apiUrl: string
  token: string
  /** Where the credentials came from (core/nexus-config.ts), for logs. */
  source?: NexusConfigSource
}

/**
 * A single tool invocation, normalized from whatever shape the runtime's
 * conversation transcript uses (OpenCode message parts vs. Claude Code
 * transcript JSONL entries). Both adapters convert their own transcript
 * format into an array of these before calling `extractNexusState()`.
 */
export interface NormalizedToolCall {
  tool: string
  args: Record<string, unknown>
  /** Parsed JSON result object, or null if absent/unparseable. */
  result: Record<string, unknown> | null
}

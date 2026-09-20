/**
 * nexus-cost-control core types (ADR-C05 core module) — runtime-agnostic.
 */

export interface NexusConfig {
  apiUrl: string
  token: string
}

export interface HeliconeConfig {
  apiKey: string
}

export interface NexusState {
  sessionId?: string
  projectId?: string
  agentId?: string
}

/**
 * Cost data aggregated from Helicone for a given Nexus session.
 */
export interface HeliconeSessionCost {
  nexusSessionId: string
  totalRequests: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  totalTokens: number
  costUsd: number
  models: string[]
  queriedAt: string
}

/**
 * A single tool invocation, normalized from whatever shape the runtime's
 * conversation transcript uses. Both adapters convert their own transcript
 * format into an array of these before calling `extractNexusState()`.
 */
export interface NormalizedToolCall {
  tool: string
  args: Record<string, unknown>
  result: Record<string, unknown> | null
}

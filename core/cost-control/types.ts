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
 * Cost/usage data for a given Nexus session, sourced either from Helicone
 * (metered cost, `costSource: "helicone"`) or aggregated directly from the
 * runtime's own transcript/message data when Helicone has no record of the
 * session (`costSource: "runtime"` — e.g. Claude Max / subscription lanes
 * that bypass the Helicone gateway). `costSource` is optional for backward
 * compatibility with existing Helicone call sites; `appendCostEntry`
 * defaults it to `"helicone"` when absent.
 *
 * `costUsd` is `null` for runtime-sourced entries — a real dollar amount is
 * not available, and reporting `0` would be indistinguishable from "ran and
 * cost nothing".
 */
export interface HeliconeSessionCost {
  nexusSessionId: string
  totalRequests: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  totalTokens: number
  costUsd: number | null
  costSource?: "helicone" | "runtime"
  models: string[]
  totalMessages?: number
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

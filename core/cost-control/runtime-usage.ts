import type { HeliconeSessionCost } from "./types.ts"

/**
 * Token/message usage aggregated directly from a runtime's own transcript or
 * message history, used as a fallback when Helicone has no record of a
 * session (ADR-C05 core module, Dispatch 515186c1). No cost figure is
 * derivable from this source — only Helicone knows the metered dollar cost.
 */
export interface RuntimeUsage {
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  totalTokens: number
  totalMessages: number
  models: string[]
}

export function emptyRuntimeUsage(): RuntimeUsage {
  return {
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    totalTokens: 0,
    totalMessages: 0,
    models: [],
  }
}

/**
 * Build a token-only cost entry from runtime-aggregated usage. `costUsd` is
 * explicitly `null` (not `0`) — a zero would be indistinguishable from "ran
 * and cost nothing", which is exactly the ambiguity a runtime-sourced entry
 * must avoid. `totalRequests` is unknown at the runtime layer (Helicone
 * tracks metered requests, not message turns) and is set to `0`;
 * `totalMessages` carries the actual assistant-message count instead.
 */
export function buildRuntimeCostEntry(nexusSessionId: string, usage: RuntimeUsage): HeliconeSessionCost {
  return {
    nexusSessionId,
    totalRequests: 0,
    tokensInput: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    tokensCacheRead: usage.tokensCacheRead,
    tokensCacheWrite: usage.tokensCacheWrite,
    totalTokens: usage.totalTokens,
    costUsd: null,
    costSource: "runtime",
    models: usage.models,
    totalMessages: usage.totalMessages,
    queriedAt: new Date().toISOString(),
  }
}

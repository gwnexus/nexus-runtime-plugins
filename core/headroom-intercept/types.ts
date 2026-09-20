/**
 * nexus-headroom-intercept core types (ADR-C05 core module).
 * Runtime-agnostic — shared by the OpenCode and Claude Code adapters.
 */

export type PolicyAction = "compress" | "passthrough" | "skip"
export type CompressionProfile = "reference-data" | "structured-list" | "search-results"

export interface Policy {
  action: PolicyAction
  profile?: CompressionProfile
  minTokens?: number
  minItems?: number
  reason?: string
}

export interface CompressionEvent {
  tool: string
  originalChars: number
  originalEstimatedTokens: number
  compressedChars: number
  compressedEstimatedTokens: number
  potentialSavedTokens: number
  compressionRatio: number
  profile: string
  contentHash: string
  sourceShape: string
  transformed: boolean
  timestamp: number
}

export interface SessionMetrics {
  totalCompressions: number
  totalObservations: number
  totalSkips: number
  totalPassthroughs: number
  totalNoGain: number
  totalUnsupportedShapes: number
  potentialSavedTokens: number
  /** Local object mutations that completed without error — NOT provider-confirmed. */
  locallyAppliedTransforms: number
  totalCacheIntegrityFailures: number
  totalFullRetrievalDenied: number
  totalOutputBudgetTruncated: number
  totalCacheReadFailures: number
  events: CompressionEvent[]
}

export function initialMetrics(): SessionMetrics {
  return {
    totalCompressions: 0,
    totalObservations: 0,
    totalSkips: 0,
    totalPassthroughs: 0,
    totalNoGain: 0,
    totalUnsupportedShapes: 0,
    potentialSavedTokens: 0,
    locallyAppliedTransforms: 0,
    totalCacheIntegrityFailures: 0,
    totalFullRetrievalDenied: 0,
    totalOutputBudgetTruncated: 0,
    totalCacheReadFailures: 0,
    events: [],
  }
}

export type PluginMode = "observe" | "transform"

export interface NexusConfig {
  apiUrl: string
  token: string
  source?: string
}

export interface ProjectContext {
  projectId: string
  plugins: string[]
  headroomEnabled: boolean
}

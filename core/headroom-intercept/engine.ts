import { lookupPolicy, DEFAULT_MIN_TOKENS } from "./policies.ts"
import { compressByProfile, contentHash, estimateTokens, MINIMUM_SAVING_RATIO } from "./compression.ts"
import type { CompressionEvent, PluginMode, SessionMetrics } from "./types.ts"
import type { OriginalStore } from "./store.ts"
import type { StructuredLogger } from "./structured-logger.ts"

/**
 * Runtime-agnostic interception engine (ADR-C05 core module).
 *
 * Both adapters normalize their runtime's tool-output shape into plain text
 * first (OpenCode: `output.output` string or MCP `content[]`; Claude Code:
 * `tool_response` string or object), then hand it to `intercept()` here,
 * which does the actual policy lookup, threshold check, compression, and
 * no-gain guard. The adapter is only responsible for applying the resulting
 * `compact` text back into its runtime's output shape.
 */

export type InterceptAction =
  | "skip"
  | "passthrough"
  | "unsupported_shape"
  | "no_gain"
  | "transform_candidate"
  | "observed"

export interface InterceptResult {
  action: InterceptAction
  compact?: string
  event?: CompressionEvent
}

export interface InterceptInput {
  toolName: string
  /** Extracted text content, or null/empty if the shape is unsupported. */
  text: string | null
  supported: boolean
  sourceShape: string
  isError: boolean
  mode: PluginMode
  /** Response carries content that must not be replaced (e.g. non-text blocks); treated like isError. */
  preserveVerbatim?: boolean
  /** Structure-only diagnostics (never content) attached to `unsupported_shape` log lines. */
  shapeDiagnostics?: Record<string, unknown>
}

export function intercept(
  input: InterceptInput,
  metrics: SessionMetrics,
  store: OriginalStore,
  logger: StructuredLogger,
): InterceptResult {
  const { toolName, isError, mode, sourceShape } = input

  if (!toolName) return { action: "skip" }

  logger.debug("hook_invoked", { tool: toolName })

  const { policy, noMatch } = lookupPolicy(toolName)
  if (noMatch || !policy) {
    metrics.totalSkips++
    logger.debug("policy_skip", { tool: toolName, reason: "no-nexus-prefix" })
    return { action: "skip" }
  }

  if (policy.action === "skip") {
    metrics.totalSkips++
    logger.debug("policy_skip", { tool: toolName, reason: policy.reason })
    return { action: "skip" }
  }
  if (policy.action === "passthrough") {
    metrics.totalPassthroughs++
    logger.debug("policy_passthrough", { tool: toolName, reason: policy.reason })
    return { action: "passthrough" }
  }

  // Never compress error responses — must be preserved verbatim.
  if (isError || input.preserveVerbatim) {
    metrics.totalPassthroughs++
    return { action: "passthrough" }
  }

  if (!input.supported || !input.text) {
    metrics.totalUnsupportedShapes++
    logger.log("warn", "unsupported_shape", { tool: toolName, sourceShape, ...input.shapeDiagnostics })
    return { action: "unsupported_shape" }
  }

  const text = input.text
  const estimatedTokens = estimateTokens(text)
  const threshold = policy.minTokens ?? DEFAULT_MIN_TOKENS

  if (estimatedTokens < threshold) {
    metrics.totalPassthroughs++
    logger.debug("below_threshold", { tool: toolName, estimatedTokens, threshold })
    return { action: "passthrough" }
  }

  logger.debug("compress_candidate", {
    tool: toolName,
    profile: policy.profile,
    estimatedTokens,
    threshold,
    mode,
  })

  const hash = contentHash(text)
  const profile = policy.profile ?? "reference-data"
  const compact = compressByProfile(text, profile, hash, toolName, () => {
    metrics.totalOutputBudgetTruncated++
    logger.log("info", "output_budget_truncated", {
      tool: toolName,
      profile,
      hash,
      mode,
      transformed: mode === "transform",
    })
  })
  const compressedTokens = estimateTokens(compact)
  const savedTokens = estimatedTokens - compressedTokens

  const savingRatio = savedTokens / estimatedTokens
  if (compressedTokens >= estimatedTokens || savingRatio < MINIMUM_SAVING_RATIO) {
    metrics.totalNoGain++
    logger.log("info", "no_gain", {
      tool: toolName,
      estimatedTokens,
      compressedTokens,
      savingRatio: savingRatio.toFixed(3),
    })
    return { action: "no_gain" }
  }

  if (mode === "transform") {
    store.set(hash, text)
    store.prune()
    logger.debug("original_stored", { tool: toolName, hash, originalChars: text.length })
  }

  const event: CompressionEvent = {
    tool: toolName,
    originalChars: text.length,
    originalEstimatedTokens: estimatedTokens,
    compressedChars: compact.length,
    compressedEstimatedTokens: compressedTokens,
    potentialSavedTokens: savedTokens,
    compressionRatio: compressedTokens / estimatedTokens,
    profile,
    contentHash: hash,
    sourceShape,
    transformed: false,
    timestamp: Date.now(),
  }

  metrics.potentialSavedTokens += savedTokens

  if (mode === "transform") {
    // Adapter must attempt to apply `compact` to its runtime's output shape
    // and call commitTransformed() on success or commitTransformFailed() on
    // failure (fail-open — original output is left untouched on error).
    return { action: "transform_candidate", compact, event }
  }

  commitObserved(event, metrics, logger)
  return { action: "observed", compact, event }
}

/** Call after successfully applying the compact text to the runtime's tool output. */
export function commitTransformed(event: CompressionEvent, metrics: SessionMetrics, logger: StructuredLogger): void {
  event.transformed = true
  metrics.totalCompressions++
  metrics.locallyAppliedTransforms++
  metrics.events.push(event)
  logger.log("info", "transform", {
    tool: event.tool,
    originalTokens: event.originalEstimatedTokens,
    compressedTokens: event.compressedEstimatedTokens,
    potentialSavedTokens: event.potentialSavedTokens,
    ratio: event.compressionRatio.toFixed(3),
    hash: event.contentHash,
    sourceShape: event.sourceShape,
  })
}

/** Call if applying the compact text to the runtime's tool output threw — fail-open. */
export function commitTransformFailed(
  event: CompressionEvent,
  metrics: SessionMetrics,
  logger: StructuredLogger,
  error: unknown,
): void {
  metrics.totalObservations++
  logger.log("error", "transform_failed", { tool: event.tool, error: String(error) })
}

function commitObserved(event: CompressionEvent, metrics: SessionMetrics, logger: StructuredLogger): void {
  metrics.totalObservations++
  logger.log("info", "observe", {
    tool: event.tool,
    estimatedTokens: event.originalEstimatedTokens,
    potentialSavedTokens: event.potentialSavedTokens,
    ratio: event.compressionRatio.toFixed(3),
    hash: event.contentHash,
    sourceShape: event.sourceShape,
  })
  metrics.events.push(event)
}

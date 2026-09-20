#!/usr/bin/env node
/**
 * Nexus Headroom Intercept — Claude Code adapter (ADR-C05, Track B2, Dispatch dc5fdf9a).
 *
 * Capability matrix: `headroom_intercept` = "full" parity target for Claude
 * Code via `PostToolUse` returning an updated tool output. All policy,
 * compression, cache, and credential-resolution logic lives in
 * `core/headroom-intercept/*` and is shared verbatim with the OpenCode
 * adapter; this file only handles Claude Code-specific concerns.
 *
 * VERIFY BEFORE PRODUCTION USE: the exact `PostToolUse` output field name
 * for replacing tool output. This adapter emits both
 * `hookSpecificOutput.updatedToolOutput` (per the capability-matrix draft
 * text) and `hookSpecificOutput.additionalContext` as a fallback, since the
 * precise field was not runtime-verified against a live Claude Code install
 * in this pass — see https://code.claude.com/docs/en/hooks and update this
 * adapter (and the capability matrix) once confirmed.
 *
 * Design differences from the OpenCode adapter (both intentional, both
 * disclosed):
 *
 *  1. Retrieval tool: NOT implemented here. Per capability-matrix
 *     `custom_tools` = "none" for Claude Code (no custom-tool-registration
 *     hook exists), the `nexus_headroom_intercept_retrieve` capability must
 *     be exposed as an MCP tool on the Nexus MCP server, not a
 *     runtime-plugin-registered tool. This adapter still writes originals
 *     to the same on-disk OriginalStore cache (`.nexus/headroom-cache/`)
 *     so a future Nexus-MCP-side retrieval tool can read them; it does not
 *     itself expose a retrieval mechanism to the agent. A `retrieve` CLI
 *     mode is provided below for manual/debugging use only.
 *
 *  2. Project/credential gate: computed once and cached to
 *     `.nexus/headroom-gate-state.json` with a 10-minute TTL, instead of
 *     performing a live network preflight call on every single tool-call
 *     hook invocation (Claude Code spawns a fresh process per hook event,
 *     unlike OpenCode's long-lived plugin instance — a per-call network
 *     round trip would add latency to every tool call). SDK-version gating
 *     (OpenCode-specific) does not apply here and is omitted.
 *
 *  3. Session summary: OpenCode emits ` session.idle`; Claude Code has no
 *     equivalent (see capability-matrix `cost_control` entry for the same
 *     gap in a different plugin). Metrics are persisted to
 *     `.nexus/headroom-metrics-state.json` between invocations and flushed
 *     as a `session_summary` log line on the `Stop` hook.
 *
 * Hook configuration (.claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "PostToolUse": [
 *         {
 *           "matcher": "nexus_.*|headroom_.*",
 *           "hooks": [{ "type": "command", "command": "node adapters/claude-code/headroom-intercept/nexus-headroom-intercept.ts post-tool-use" }]
 *         }
 *       ],
 *       "Stop": [
 *         { "hooks": [{ "type": "command", "command": "node adapters/claude-code/headroom-intercept/nexus-headroom-intercept.ts stop" }] }
 *       ]
 *     }
 *   }
 */
import { loadState, saveState } from "../../../core/state-store.ts"
import { StructuredLogger } from "../../../core/headroom-intercept/structured-logger.ts"
import { OriginalStore } from "../../../core/headroom-intercept/store.ts"
import { getNexusConfig, readProjectIdFromAgentsMd, fetchProjectContext } from "../../../core/headroom-intercept/config.ts"
import { initialMetrics } from "../../../core/headroom-intercept/types.ts"
import type { PluginMode, SessionMetrics } from "../../../core/headroom-intercept/types.ts"
import { wrapRetrievedContent } from "../../../core/headroom-intercept/compression.ts"
import { intercept, commitTransformed, commitTransformFailed } from "../../../core/headroom-intercept/engine.ts"

const PLUGIN_META = { name: "nexus-headroom-intercept", version: "0.5.14" } as const

const DEFAULT_MODE: PluginMode = "observe"
const DEBUG = process.env.HEADROOM_DEBUG === "true"
const GATE_STATE_FILE = "headroom-gate-state.json"
const METRICS_STATE_FILE = "headroom-metrics-state.json"
const GATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Read fresh on every gate computation (not cached at module load) so tests and
 *  live env changes both behave predictably. */
function requirePreflight(): boolean {
  return process.env.HEADROOM_REQUIRE_PREFLIGHT === "true"
}

interface GateState {
  mode: PluginMode
  requestedMode: PluginMode
  downgradeReason: string | null
  projectId: string | null
  gatedAt: number
}

interface ClaudeHookInput {
  cwd?: string
  tool_name?: string
  tool_response?: unknown
}

interface NormalizedResult {
  text: string
  supported: boolean
  sourceShape: "string" | "mcp-content" | "unknown"
}

/** Normalize Claude Code's tool_response shape into plain text for the core engine. */
export function normalizeClaudeToolResponse(toolResponse: unknown): NormalizedResult {
  if (typeof toolResponse === "string" && toolResponse.length > 0) {
    return { text: toolResponse, supported: true, sourceShape: "string" }
  }
  if (toolResponse && typeof toolResponse === "object" && Array.isArray((toolResponse as any).content)) {
    const textParts = (toolResponse as any).content.filter(
      (part: any) => part?.type === "text" && typeof part.text === "string",
    )
    return {
      text: textParts.map((p: any) => p.text).join("\n"),
      supported: textParts.length > 0,
      sourceShape: "mcp-content",
    }
  }
  return { text: "", supported: false, sourceShape: "unknown" }
}

async function computeGate(directory: string, logger: StructuredLogger): Promise<GateState> {
  let mode: PluginMode = (process.env.HEADROOM_MODE as PluginMode) ?? DEFAULT_MODE
  const requestedMode = mode
  let downgradeReason: string | null = null

  const projectId = readProjectIdFromAgentsMd(directory)

  if (projectId) {
    const nexusConfig = getNexusConfig(directory)
    if (nexusConfig) {
      const projectContext = await fetchProjectContext(nexusConfig, projectId)
      if (projectContext && !projectContext.headroomEnabled) {
        mode = "observe"
        downgradeReason = "project_gate_headroom_disabled"
        logger.log("warn", downgradeReason, { projectId, mode })
      } else if (!projectContext && requirePreflight() && mode === "transform") {
        mode = "observe"
        downgradeReason = "project_gate_preflight_unreachable_strict"
        logger.log("warn", downgradeReason, { projectId, mode })
      }
    } else if (requirePreflight() && mode === "transform") {
      mode = "observe"
      downgradeReason = "project_gate_no_credentials_strict"
      logger.log("warn", downgradeReason, { mode })
    }
  } else if (mode === "transform") {
    mode = "observe"
    downgradeReason = "project_gate_no_project_id_transform_downgrade"
    logger.log("warn", downgradeReason, { mode, reason: "unknown namespace — transform requires explicit project identity" })
  }

  return { mode, requestedMode, downgradeReason, projectId, gatedAt: Date.now() }
}

async function getGate(directory: string, logger: StructuredLogger): Promise<GateState> {
  const cached = loadState<GateState | null>(directory, GATE_STATE_FILE, null)
  if (cached && Date.now() - cached.gatedAt < GATE_TTL_MS) {
    return cached
  }
  const fresh = await computeGate(directory, logger)
  saveState(directory, GATE_STATE_FILE, fresh)
  return fresh
}

/** Testable handler for the `post-tool-use` mode. */
export async function handlePostToolUse(
  input: ClaudeHookInput,
  logger: StructuredLogger,
): Promise<Record<string, unknown> | null> {
  const directory = input.cwd ?? process.cwd()
  const toolName = String(input.tool_name ?? "")
  if (!toolName) return null

  const gate = await getGate(directory, logger)
  const store = new OriginalStore(directory, gate.projectId)
  const metrics = loadState<SessionMetrics>(directory, METRICS_STATE_FILE, initialMetrics())

  const normalized = normalizeClaudeToolResponse(input.tool_response)
  const result = intercept(
    {
      toolName,
      text: normalized.text || null,
      supported: normalized.supported,
      sourceShape: normalized.sourceShape,
      isError: false, // Claude Code's PostToolUse does not surface a distinct isError flag on tool_response
      mode: gate.mode,
    },
    metrics,
    store,
    logger,
  )

  saveState(directory, METRICS_STATE_FILE, metrics)

  if (result.action !== "transform_candidate" || !result.compact || !result.event) {
    return null
  }

  try {
    commitTransformed(result.event, metrics, logger)
    saveState(directory, METRICS_STATE_FILE, metrics)
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        // VERIFY field name against current Claude Code hooks docs (see file header).
        updatedToolOutput: result.compact,
        additionalContext: result.compact,
      },
    }
  } catch (err) {
    commitTransformFailed(result.event, metrics, logger, err)
    saveState(directory, METRICS_STATE_FILE, metrics)
    return null
  }
}

/** Testable handler for the `stop` mode — flush accumulated metrics as a session_summary. */
export function handleStop(directory: string, logger: StructuredLogger): void {
  const metrics = loadState<SessionMetrics>(directory, METRICS_STATE_FILE, initialMetrics())
  const hasActivity =
    metrics.events.length > 0 ||
    metrics.totalCacheIntegrityFailures > 0 ||
    metrics.totalOutputBudgetTruncated > 0 ||
    metrics.totalUnsupportedShapes > 0 ||
    metrics.totalCacheReadFailures > 0

  if (hasActivity) {
    logger.log("info", "session_summary", {
      compressions: metrics.totalCompressions,
      locallyAppliedTransforms: metrics.locallyAppliedTransforms,
      observations: metrics.totalObservations,
      skips: metrics.totalSkips,
      passthroughs: metrics.totalPassthroughs,
      noGain: metrics.totalNoGain,
      unsupportedShapes: metrics.totalUnsupportedShapes,
      potentialSavedTokens: metrics.potentialSavedTokens,
      cacheIntegrityFailures: metrics.totalCacheIntegrityFailures,
      outputBudgetTruncated: metrics.totalOutputBudgetTruncated,
      cacheReadFailures: metrics.totalCacheReadFailures,
    })
  }
  // Reset for the next turn/session.
  saveState(directory, METRICS_STATE_FILE, initialMetrics())
}

/** Manual/debugging-only retrieval, NOT exposed to the agent (see file header). */
export function debugRetrieve(directory: string, projectId: string | null, hash: string, query?: string): string {
  const store = new OriginalStore(directory, projectId)
  const content = store.get(hash)
  if (!content) return JSON.stringify({ found: false, hash })
  if (query && query.trim()) {
    const matched = content.split("\n").filter((l) => l.toLowerCase().includes(query.toLowerCase()))
    return JSON.stringify({ found: true, hash, content: wrapRetrievedContent(matched.join("\n")) })
  }
  return JSON.stringify({ found: true, hash, content: wrapRetrievedContent(content) })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf-8")
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ""
  const raw = await readStdin()

  let input: ClaudeHookInput = {}
  try {
    input = JSON.parse(raw || "{}")
  } catch {
    process.exit(0)
  }

  const directory = input.cwd ?? process.cwd()
  const logger = new StructuredLogger(directory, PLUGIN_META.name, PLUGIN_META.version, DEBUG)

  if (mode === "post-tool-use") {
    const output = await handlePostToolUse(input, logger)
    if (output) process.stdout.write(JSON.stringify(output))
    process.exit(0)
  }

  if (mode === "stop") {
    handleStop(directory, logger)
    process.exit(0)
  }

  logger.log("warn", "unknown_mode", { mode })
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}\n`)
    process.exit(0)
  })
}

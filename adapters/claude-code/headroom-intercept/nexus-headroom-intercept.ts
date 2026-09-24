#!/usr/bin/env node
/**
 * Nexus Headroom Intercept — Claude Code adapter (ADR-C05, Track B2, Dispatch dc5fdf9a).
 *
 * Capability matrix: `headroom_intercept` = "full" for Claude Code via
 * `PostToolUse` returning `hookSpecificOutput.updatedToolOutput`. All
 * policy, compression, cache, and credential-resolution logic lives in
 * `core/headroom-intercept/*` and is shared verbatim with the OpenCode
 * adapter; this file only handles Claude Code-specific concerns.
 *
 * VERIFIED against the official Claude Code hooks reference
 * (code.claude.com/docs/en/hooks) on 2026-09-20, see Dispatch `dc5fdf9a`
 * reply from nexus-app: `hookSpecificOutput.updatedToolOutput` is the
 * correct field to REPLACE tool output (this plugin's actual need —
 * compression); `additionalContext` is a different field that only ADDS
 * supplementary text alongside the original result, so it does not do what
 * we need and is no longer emitted here.
 *
 * IMPORTANT CONFIRMED CAVEAT (verbatim from the docs): "The replacement
 * value must match the tool's output shape. Built-in tools return
 * structured objects rather than plain strings... For built-in tools, a
 * value that doesn't match the tool's output schema is ignored and the
 * original output is used. MCP tool output is passed through without
 * schema validation." This plugin's policy table
 * (`core/headroom-intercept/policies.ts`) only ever assigns a `compress`
 * action to `nexus_`/`headroom_`-prefixed MCP tools; every built-in tool
 * (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `shell`) is explicitly
 * `skip`. A plain-string `updatedToolOutput` is therefore always safe here
 * — this plugin never attempts to replace a built-in tool's structured
 * output. If the policy table is ever extended to compress a built-in
 * tool's output, that entry MUST preserve the tool's native output shape
 * (e.g. `{ stdout, stderr, interrupted, isImage }` for Bash) instead of a
 * plain string, or the replacement will be silently ignored.
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
 *     `.nexus/headroom-metrics-state.json` between invocations, accumulated
 *     cumulatively across the whole session (Fix §3, Dispatch 0e38cf7b: a
 *     new `session_id` reported by the hook input is the only reset
 *     trigger; the `Stop` hook fires after every assistant turn, not once
 *     per session, so resetting on every `Stop` previously caused
 *     `nexus-cli` to observe only the last turn's numbers), and flushed as a
 *     cumulative `session_summary` log line on every `Stop`.
 *
 * Fix log (Dispatch 0e38cf7b, 2026-09-24):
 *   §1 Tool-name mismatch — `mcp__<server>__<tool>` MCP tool names are now
 *      normalized to the core policy table's naming convention
 *      (`normalizeClaudeToolName`) before policy lookup.
 *   §2 Credential-source drift — see `core/headroom-intercept/config.ts` for
 *      the updated resolution order (env, `.mcp.json`, `opencode.json`,
 *      project-local `.nexus/config.toml`+`credentials.toml`, global).
 *   §3 Per-turn vs per-session stats — see above.
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

const PLUGIN_META = { name: "nexus-headroom-intercept", version: "0.5.17" } as const

const DEFAULT_MODE: PluginMode = "observe"
const DEBUG = process.env.HEADROOM_DEBUG === "true"
const GATE_STATE_FILE = "headroom-gate-state.json"
const METRICS_STATE_FILE = "headroom-metrics-state.json"
const SESSION_ID_STATE_FILE = "headroom-session-id.json"
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
  session_id?: string
}

type SourceShape =
  | "string"
  | "mcp-content-array"
  | "mcp-content"
  | "mcp-content-string"
  | "mcp-structured-content"
  | "unknown"

interface NormalizedResult {
  text: string
  supported: boolean
  sourceShape: SourceShape
  /** Non-text blocks or an error flag present: the original must not be replaced. */
  preserveVerbatim: boolean
}

/**
 * Normalize Claude Code's MCP tool name into the core policy table's naming
 * convention (Fix §1, Dispatch 0e38cf7b). Claude Code passes MCP tools as
 * `mcp__<server>__<tool>` (e.g. `mcp__nexus__kb_memory`,
 * `mcp__nexus-headroom__headroom_retrieve`), while the core policy table
 * (`core/headroom-intercept/policies.ts`) only knows OpenCode-style names
 * (`nexus_kb_memory`, `headroom_retrieve`). Without this normalization every
 * Claude Code MCP tool call falls through `lookupPolicy()` as a no-match
 * skip, so the plugin never compresses anything.
 */
export function normalizeClaudeToolName(toolName: string): string {
  const mcpMatch = toolName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/)
  if (!mcpMatch) return toolName
  const [, server, rest] = mcpMatch
  if (server === "nexus-headroom") return rest
  if (server === "nexus") return `nexus_${rest}`
  return toolName
}

function fromContentBlocks(blocks: unknown[], sourceShape: SourceShape): NormalizedResult {
  const textParts = blocks.filter((b: any) => b?.type === "text" && typeof b.text === "string") as { text: string }[]
  return {
    text: textParts.map((p) => p.text).join("\n"),
    supported: textParts.length > 0,
    sourceShape,
    preserveVerbatim: textParts.length > 0 && textParts.length < blocks.length,
  }
}

/**
 * Normalize Claude Code's tool_response shape into plain text for the core engine.
 *
 * Captured live (Claude Code 2.1.x, Dispatch 1bc7ff92, 2026-09-24): for MCP
 * tools, PostToolUse `tool_response` is a BARE ARRAY of content blocks
 * (`[{ type: "text", text }]`), not `{ content: [...] }`. The object forms are
 * still accepted defensively. Any non-text block marks the response
 * `preserveVerbatim` so it is never replaced by a text-only compaction.
 */
export function normalizeClaudeToolResponse(toolResponse: unknown): NormalizedResult {
  if (typeof toolResponse === "string" && toolResponse.length > 0) {
    return { text: toolResponse, supported: true, sourceShape: "string", preserveVerbatim: false }
  }
  if (Array.isArray(toolResponse)) {
    return fromContentBlocks(toolResponse, "mcp-content-array")
  }
  if (toolResponse && typeof toolResponse === "object") {
    const obj = toolResponse as Record<string, unknown>
    const isError = obj.isError === true
    if (Array.isArray(obj.content)) {
      const r = fromContentBlocks(obj.content, "mcp-content")
      if (r.supported || obj.structuredContent === undefined) return { ...r, preserveVerbatim: r.preserveVerbatim || isError }
    }
    if (typeof obj.content === "string" && obj.content.length > 0) {
      return { text: obj.content, supported: true, sourceShape: "mcp-content-string", preserveVerbatim: isError }
    }
    if (obj.structuredContent !== undefined && obj.structuredContent !== null) {
      return {
        text: JSON.stringify(obj.structuredContent),
        supported: true,
        sourceShape: "mcp-structured-content",
        preserveVerbatim: isError,
      }
    }
  }
  return { text: "", supported: false, sourceShape: "unknown", preserveVerbatim: false }
}

/** Structure-only description of a tool_response for diagnostics. Never includes content. */
export function describeResponseShape(toolResponse: unknown): Record<string, unknown> {
  const blockKeys = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : typeof v)
  if (Array.isArray(toolResponse)) {
    return { responseType: "array", responseLength: toolResponse.length, firstBlockKeys: blockKeys(toolResponse[0]) }
  }
  if (toolResponse && typeof toolResponse === "object") {
    const content = (toolResponse as Record<string, unknown>).content
    return {
      responseType: "object",
      topLevelKeys: Object.keys(toolResponse),
      ...(Array.isArray(content) ? { firstBlockKeys: blockKeys(content[0]) } : {}),
    }
  }
  return { responseType: toolResponse === null ? "null" : typeof toolResponse }
}

/** Mirror the source shape in `updatedToolOutput` so the replacement matches what Claude Code sent. */
function toUpdatedToolOutput(compact: string, sourceShape: SourceShape): unknown {
  if (sourceShape === "string") return compact
  const blocks = [{ type: "text", text: compact }]
  return sourceShape === "mcp-content-array" ? blocks : { content: blocks }
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

/**
 * Load accumulated metrics for the current session (Fix §3, Dispatch
 * 0e38cf7b). Claude Code fires `Stop` after every assistant turn, not once
 * per session, so metrics must persist across turns and only reset when the
 * `session_id` reported by the hook input actually changes (a genuinely new
 * session starting), not on every `Stop`.
 */
function loadMetricsForSession(directory: string, sessionId: string | undefined): SessionMetrics {
  const lastSessionId = loadState<string | null>(directory, SESSION_ID_STATE_FILE, null)
  if (sessionId && lastSessionId !== sessionId) {
    saveState(directory, SESSION_ID_STATE_FILE, sessionId)
    const fresh = initialMetrics()
    saveState(directory, METRICS_STATE_FILE, fresh)
    return fresh
  }
  return loadState<SessionMetrics>(directory, METRICS_STATE_FILE, initialMetrics())
}

/** Testable handler for the `post-tool-use` mode. */
export async function handlePostToolUse(
  input: ClaudeHookInput,
  logger: StructuredLogger,
): Promise<Record<string, unknown> | null> {
  const directory = input.cwd ?? process.cwd()
  const rawToolName = String(input.tool_name ?? "")
  if (!rawToolName) return null
  const toolName = normalizeClaudeToolName(rawToolName)

  const gate = await getGate(directory, logger)
  const store = new OriginalStore(directory, gate.projectId)
  const metrics = loadMetricsForSession(directory, input.session_id)

  const normalized = normalizeClaudeToolResponse(input.tool_response)
  const result = intercept(
    {
      toolName,
      text: normalized.text || null,
      supported: normalized.supported,
      sourceShape: normalized.sourceShape,
      isError: false, // PostToolUse only fires on success; an explicit isError on the object shape is folded into preserveVerbatim
      mode: gate.mode,
      preserveVerbatim: normalized.preserveVerbatim,
      shapeDiagnostics: normalized.supported ? undefined : describeResponseShape(input.tool_response),
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
        // Confirmed field name (2026-09-20, official hooks reference). MCP
        // output is not schema-validated, but the replacement still mirrors
        // the source shape (bare content-block array for live MCP calls).
        updatedToolOutput: toUpdatedToolOutput(result.compact, normalized.sourceShape),
      },
    }
  } catch (err) {
    commitTransformFailed(result.event, metrics, logger, err)
    saveState(directory, METRICS_STATE_FILE, metrics)
    return null
  }
}

/** Testable handler for the `stop` mode — flush accumulated metrics as a cumulative session_summary. */
export function handleStop(directory: string, logger: StructuredLogger, sessionId?: string): void {
  const metrics = loadMetricsForSession(directory, sessionId)
  const hasActivity =
    metrics.events.length > 0 ||
    metrics.totalCacheIntegrityFailures > 0 ||
    metrics.totalOutputBudgetTruncated > 0 ||
    metrics.totalUnsupportedShapes > 0 ||
    metrics.totalCacheReadFailures > 0

  if (hasActivity) {
    // Stop must not hit the network: read the gate cached by PostToolUse
    // (TTL ignored here); fall back to the requested mode if none exists yet.
    const gate = loadState<GateState | null>(directory, GATE_STATE_FILE, null)
    const requestedMode = gate?.requestedMode ?? (process.env.HEADROOM_MODE as PluginMode) ?? DEFAULT_MODE
    logger.log("info", "session_summary", {
      session_id: sessionId ?? null,
      mode: gate?.mode ?? requestedMode,
      requestedMode,
      downgradeReason: gate?.downgradeReason ?? null,
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
  // Cumulative across the whole session — do NOT reset here. Metrics only
  // reset when loadMetricsForSession() detects a new session_id (see Fix §3
  // docstring above).
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
    handleStop(directory, logger, input.session_id)
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

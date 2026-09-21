#!/usr/bin/env node
/**
 * Nexus Cost Control — Claude Code adapter (ADR-C05, Track B2, Dispatch dc5fdf9a).
 *
 * Capability matrix: `cost_control` = "partial" for Claude Code. Claude Code
 * has no idle-detection event (no equivalent to OpenCode's `session.idle`);
 * cost summaries must be recomputed around session `Stop`/`SessionEnd`
 * instead, which fires on a different cadence than OpenCode's idle-based
 * debounced summary. Disclosed per the capability matrix, not worked
 * around: this adapter records a cost snapshot on `Stop` (per-turn-ish) with
 * the same token-delta dedup guard as the OpenCode adapter, rather than
 * attempting to fake an idle-debounce window.
 *
 * The `nexus_cost_summary` on-demand tool becomes an MCP tool rather than a
 * runtime-registered custom tool (Claude Code has no custom-tool-
 * registration hook, matching the `custom_tools` = "none" entry in the
 * capability matrix) -- NOT implemented as a Claude Code hook script here;
 * this is a follow-up for the Nexus MCP server itself, same as the
 * headroom-intercept retrieval tool gap.
 *
 * All credential resolution, state extraction, Helicone querying,
 * formatting, and the Nexus API call are shared verbatim with the OpenCode
 * adapter via core/cost-control/*.
 *
 * Session/token-delta state is persisted to
 * `.nexus/cost-control-state.json` between invocations (Claude Code spawns
 * a fresh process per hook event, unlike OpenCode's long-lived plugin
 * instance).
 *
 * VERIFY BEFORE PRODUCTION USE: this adapter assumes `transcript_path`
 * points to a standard Claude Code transcript JSONL file (same assumption
 * and parser as the compaction-plus Claude Code adapter) -- not
 * runtime-verified against a live Claude Code install in this pass.
 *
 * Hook configuration (.claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "Stop": [
 *         { "hooks": [{ "type": "command", "command": "node adapters/claude-code/cost-control/nexus-cost-control.ts stop" }] }
 *       ]
 *     }
 *   }
 */
import { existsSync, readFileSync } from "node:fs"
import { createFileLogger } from "../../../core/logger.ts"
import { loadState, saveState } from "../../../core/state-store.ts"
import { getNexusConfig, getHeliconeConfig } from "../../../core/cost-control/config.ts"
import { extractNexusState } from "../../../core/cost-control/state.ts"
import { queryHeliconeSession } from "../../../core/cost-control/helicone.ts"
import { appendCostEntry } from "../../../core/cost-control/api.ts"
import { emptyRuntimeUsage, buildRuntimeCostEntry, type RuntimeUsage } from "../../../core/cost-control/runtime-usage.ts"
import type { NormalizedToolCall } from "../../../core/cost-control/types.ts"

const PLUGIN_META = { name: "nexus-cost-control", version: "1.1.0" } as const
const STATE_FILE = "cost-control-state.json"

interface CostControlState {
  lastAppendAt: number | null
  lastAppendedTokens: number | null
}

function initialState(): CostControlState {
  return { lastAppendAt: null, lastAppendedTokens: null }
}

interface ClaudeHookInput {
  cwd?: string
  transcript_path?: string
}

/**
 * Parse a Claude Code transcript JSONL file into the shared
 * NormalizedToolCall[] shape. Same tool_use/tool_result pairing approach as
 * the compaction-plus Claude Code adapter.
 */
export function parseClaudeTranscript(transcriptPath: string): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = []
  if (!existsSync(transcriptPath)) return calls

  let raw: string
  try {
    raw = readFileSync(transcriptPath, "utf-8")
  } catch {
    return calls
  }

  const pendingById = new Map<string, { tool: string; args: Record<string, unknown> }>()
  const resultById = new Map<string, Record<string, unknown> | null>()

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    const content = entry?.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        pendingById.set(block.id, { tool: block.name, args: block.input ?? {} })
      }
      if (block?.type === "tool_result" && block.tool_use_id) {
        const text = Array.isArray(block.content)
          ? block.content.find((c: any) => c?.type === "text")?.text
          : typeof block.content === "string"
            ? block.content
            : undefined
        let parsed: Record<string, unknown> | null = null
        if (typeof text === "string") {
          try {
            const j = JSON.parse(text)
            if (typeof j === "object" && j !== null) parsed = j
          } catch {
            // non-JSON tool result text — leave result null
          }
        }
        resultById.set(block.tool_use_id, parsed)
      }
    }
  }

  for (const [id, pending] of pendingById) {
    calls.push({ tool: pending.tool, args: pending.args, result: resultById.get(id) ?? null })
  }

  return calls
}

const IDLE_DEBOUNCE_MS = 5 * 60 * 1000 // 5 minutes — same window as the OpenCode adapter

/**
 * Aggregate token usage directly from a Claude Code transcript's assistant
 * message `usage` blocks, used as a fallback cost-control source when
 * Helicone has no data for a session (Dispatch 515186c1) -- e.g. Claude Max
 * sessions that talk directly to Anthropic and never pass through the
 * Helicone gateway. No cost figure is derivable here -- only Helicone knows
 * the metered dollar cost.
 */
export function aggregateClaudeUsage(transcriptPath: string): RuntimeUsage {
  const usage = emptyRuntimeUsage()
  if (!existsSync(transcriptPath)) return usage

  let raw: string
  try {
    raw = readFileSync(transcriptPath, "utf-8")
  } catch {
    return usage
  }

  const modelsSet = new Set<string>()

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    const message = entry?.message
    if (!message || message.role !== "assistant") continue

    usage.totalMessages += 1
    const u = message.usage
    if (u) {
      usage.tokensInput += u.input_tokens ?? 0
      usage.tokensOutput += u.output_tokens ?? 0
      usage.tokensCacheRead += u.cache_read_input_tokens ?? 0
      usage.tokensCacheWrite += u.cache_creation_input_tokens ?? 0
    }
    if (message.model) modelsSet.add(message.model)
  }

  usage.totalTokens = usage.tokensInput + usage.tokensOutput
  usage.models = Array.from(modelsSet)
  return usage
}

/** Testable handler for the `stop` mode. */
export async function handleStop(
  input: ClaudeHookInput,
  logger: (level: string, message: string) => void,
): Promise<void> {
  const directory = input.cwd ?? process.cwd()
  const nexusConfig = getNexusConfig(directory)
  const heliconeConfig = getHeliconeConfig(directory)

  if (!nexusConfig || !heliconeConfig) {
    logger("debug", "Stop — skipping (Nexus or Helicone config not present)")
    return
  }

  const state = loadState<CostControlState>(directory, STATE_FILE, initialState())

  if (state.lastAppendAt && Date.now() - state.lastAppendAt < IDLE_DEBOUNCE_MS) {
    logger("debug", `Stop — skipping (last append ${Date.now() - state.lastAppendAt}ms ago)`)
    return
  }

  if (!input.transcript_path) {
    logger("warn", "Stop — no transcript_path in hook input, skipping")
    return
  }

  const calls = parseClaudeTranscript(input.transcript_path)
  const nexusState = extractNexusState(calls, (m) => logger("debug", m))

  if (!nexusState.sessionId) {
    logger("info", "No Nexus session ID found — skipping cost recording")
    return
  }

  const cost = await queryHeliconeSession(heliconeConfig, nexusState.sessionId, (level, msg) => logger(level, msg))
  let entry = cost
  if (!entry) {
    const usage = aggregateClaudeUsage(input.transcript_path)
    if (usage.totalMessages === 0) {
      logger("info", `No Helicone data for session ${nexusState.sessionId} — skipping`)
      return
    }
    entry = buildRuntimeCostEntry(nexusState.sessionId, usage)
    logger(
      "info",
      `No Helicone data for session ${nexusState.sessionId} — falling back to runtime token aggregation (cost_source=runtime)`,
    )
  }

  if (state.lastAppendedTokens !== null && entry.totalTokens === state.lastAppendedTokens) {
    logger("debug", `Stop — skipping (no token delta, still ${entry.totalTokens})`)
    return
  }

  try {
    await appendCostEntry(nexusConfig, nexusState.sessionId, entry, PLUGIN_META, (level, msg) => logger(level, msg))
    state.lastAppendAt = Date.now()
    state.lastAppendedTokens = entry.totalTokens
    saveState(directory, STATE_FILE, state)
    const costLabel = entry.costUsd === null ? "n/a (runtime)" : `$${entry.costUsd.toFixed(6)}`
    logger("info", `Cost entry recorded — ${costLabel} / ${entry.totalTokens} tokens`)
  } catch (err) {
    logger("error", `Failed to record cost entry: ${err}`)
  }
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
  const fileLog = createFileLogger(directory, "cost-control.log")
  const logger = (level: string, message: string) => fileLog(level, message)

  if (mode === "stop") {
    await handleStop(input, logger)
    process.exit(0)
  }

  fileLog("warn", `Unknown mode "${mode}" (expected stop) — no-op`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}\n`)
    process.exit(0)
  })
}

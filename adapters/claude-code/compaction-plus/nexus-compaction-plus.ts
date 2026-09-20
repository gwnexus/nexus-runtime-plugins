#!/usr/bin/env node
/**
 * Nexus Compaction Plus — Claude Code adapter (ADR-C05, Track B2, Dispatch dc5fdf9a).
 *
 * Capability matrix: `compaction_plus` = "partial" for Claude Code. Mechanism
 * exists (`PreCompact` / `PostCompact` hooks) and `PostCompact` supplies the
 * generated compact summary directly per the hooks reference, which is
 * actually simpler than OpenCode's two-phase session.compacted +
 * message.updated diffing approach — but interactive vs. `claude -p`
 * (headless) hook behavior has NOT been verified identical in this pass.
 *
 * Per the dispatch: "please add an integration test covering both modes and
 * pin a minimum Claude Code version if behavior differs" — this is flagged
 * as a required follow-up before claiming full parity.
 *
 * VERIFY BEFORE PRODUCTION USE:
 *  - The exact `PreCompact`/`PostCompact` hook input JSON shape (this
 *    adapter assumes `transcript_path` points to a JSONL transcript file
 *    with Claude Code's standard message format, and that `PostCompact`
 *    input includes a `summary` field with the generated compact summary —
 *    neither was runtime-verified against a live Claude Code install).
 *  - Interactive vs. headless (`claude -p`) parity (see capability matrix).
 *
 * Shared core logic (core/compaction-plus/*) is identical to the OpenCode
 * adapter; only transcript parsing and hook wiring differ here.
 *
 * Hook configuration (.claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "PreCompact": [
 *         {
 *           "matcher": "manual|auto",
 *           "hooks": [{ "type": "command", "command": "node adapters/claude-code/compaction-plus/nexus-compaction-plus.ts pre-compact" }]
 *         }
 *       ],
 *       "PostCompact": [
 *         { "hooks": [{ "type": "command", "command": "node adapters/claude-code/compaction-plus/nexus-compaction-plus.ts post-compact" }] }
 *       ]
 *     }
 *   }
 */
import { readFileSync, existsSync } from "node:fs"
import { createFileLogger } from "../../../core/logger.ts"
import { getNexusConfig } from "../../../core/compaction-plus/config.ts"
import { extractNexusState, buildNexusContext, cleanCompactedText, buildCompactionSummary } from "../../../core/compaction-plus/state.ts"
import { appendCompactionEntry } from "../../../core/compaction-plus/api.ts"
import type { NormalizedToolCall, NexusState } from "../../../core/compaction-plus/types.ts"

const PLUGIN_META = { name: "nexus-compaction-plus", version: "1.8.1" } as const

interface ClaudeHookInput {
  cwd?: string
  transcript_path?: string
  /** PostCompact-only, per the hooks reference: the generated compact summary text. */
  summary?: string
}

/**
 * Parse a Claude Code transcript JSONL file into the shared
 * NormalizedToolCall[] shape. Claude Code transcripts are JSONL with one
 * message per line; each message's `message.content` array may contain
 * `tool_use` blocks (name + input) and corresponding `tool_result` blocks
 * (content, keyed by tool_use_id) in a later entry.
 *
 * This parser makes a best-effort pairing of tool_use -> the next
 * tool_result seen for the same id; unmatched tool_use blocks are still
 * included with `result: null` (matches the OpenCode adapter's handling of
 * in-flight/unmatched tool calls).
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf-8")
}

/** Testable handler for the `pre-compact` mode. */
export function handlePreCompact(
  input: ClaudeHookInput,
  logger: (level: string, message: string) => void,
): Record<string, unknown> | null {
  if (!input.transcript_path) {
    logger("warn", "pre-compact: no transcript_path in hook input — skipping context injection")
    return null
  }

  const calls = parseClaudeTranscript(input.transcript_path)
  const state = extractNexusState(calls, (m) => logger("debug", m))

  if (!state.sessionId && !state.projectId) {
    logger("info", "No Nexus session/project detected — skipping context injection")
    return null
  }

  const context = buildNexusContext(state)
  logger("info", `Context injected: session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"}`)

  return {
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: context,
    },
  }
}

/** Testable handler for the `post-compact` mode. */
export async function handlePostCompact(
  input: ClaudeHookInput,
  logger: (level: string, message: string) => void,
): Promise<void> {
  const directory = input.cwd ?? process.cwd()
  const nexusConfig = getNexusConfig(directory)
  if (!nexusConfig) {
    logger("warn", "No Nexus config — skipping post-compact recording")
    return
  }

  let state: NexusState = {}
  if (input.transcript_path) {
    const calls = parseClaudeTranscript(input.transcript_path)
    state = extractNexusState(calls, (m) => logger("debug", m))
  }

  if (!state.sessionId) {
    logger("warn", "No Nexus session ID found — skipping compaction entry")
    return
  }

  const time = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
  const compactedText = cleanCompactedText(input.summary ?? "")
  const summary = buildCompactionSummary(PLUGIN_META.version, time, compactedText)

  try {
    await appendCompactionEntry(nexusConfig, state.sessionId, summary, (level, msg) => logger(level, msg))
    logger("info", `Compaction entry recorded in Nexus session ${state.sessionId}`)
  } catch (err) {
    logger("error", `Failed to record compaction entry: ${err}`)
  }
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
  const fileLog = createFileLogger(directory, "compaction-plus.log")
  const logger = (level: string, message: string) => fileLog(level, message)

  if (mode === "pre-compact") {
    const output = handlePreCompact(input, logger)
    if (output) process.stdout.write(JSON.stringify(output))
    process.exit(0)
  }

  if (mode === "post-compact") {
    await handlePostCompact(input, logger)
    process.exit(0)
  }

  fileLog("warn", `Unknown mode "${mode}" (expected pre-compact|post-compact) — no-op`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}\n`)
    process.exit(0)
  })
}

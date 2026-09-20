#!/usr/bin/env node
/**
 * Nexus Compaction Plus — Claude Code adapter (ADR-C05, Track B2, Dispatch dc5fdf9a).
 *
 * Capability matrix: `compaction_plus` = "partial" for Claude Code.
 *
 * VERIFIED against the official Claude Code hooks reference
 * (code.claude.com/docs/en/hooks) on 2026-09-20, see Dispatch `dc5fdf9a`
 * reply from nexus-app:
 *
 *  - `PostCompact` supplies the generated summary in a field named
 *    `compact_summary`, NOT `summary` (bug fixed in this pass — the
 *    previous version of this file read the wrong field and would have
 *    silently recorded an empty "Agent Summary" section on every
 *    compaction).
 *  - `additionalContext` is NOT a supported output field for `PreCompact`
 *    or `PostCompact` (confirmed: only ~10 other hook events accept it —
 *    SessionStart, SubagentStart, UserPromptSubmit, UserPromptExpansion,
 *    PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Stop,
 *    SubagentStop, PostModelSwitch). `PreCompact` therefore has NO
 *    documented mechanism to inject Nexus context before compaction at
 *    all — `handlePreCompact()` below is now a no-op (logs only) rather
 *    than attempting a return value the runtime would silently discard.
 *    This is a genuine, permanent capability gap for Claude Code, not an
 *    implementation bug: OpenCode's pre-compaction context injection
 *    (`experimental.session.compacting`) has no Claude Code equivalent.
 *
 * `PostCompact` still supplies the generated summary directly, which
 * remains simpler than OpenCode's two-phase `session.compacted` +
 * `message.updated` diffing approach for the post-compaction recording
 * half of this plugin.
 *
 * STILL UNVERIFIED (per the dispatch: "please add an integration test
 * covering both modes and pin a minimum Claude Code version if behavior
 * differs"): interactive vs. `claude -p` (headless) hook behavior parity.
 * This remains `partial` until that verification happens.
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
import { extractNexusState, cleanCompactedText, buildCompactionSummary } from "../../../core/compaction-plus/state.ts"
import { appendCompactionEntry } from "../../../core/compaction-plus/api.ts"
import type { NormalizedToolCall, NexusState } from "../../../core/compaction-plus/types.ts"

const PLUGIN_META = { name: "nexus-compaction-plus", version: "1.8.1" } as const

interface ClaudeHookInput {
  cwd?: string
  transcript_path?: string
  /** PostCompact-only. Confirmed field name (NOT `summary`) against the official hooks reference. */
  compact_summary?: string
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

/**
 * Testable handler for the `pre-compact` mode.
 *
 * CONFIRMED (2026-09-20, official hooks reference): `additionalContext` is
 * not a supported `PreCompact` output field, and no other documented
 * mechanism exists to inject content before compaction on this event. This
 * handler therefore does not attempt to return an injection payload — it
 * only extracts and logs the detected Nexus state for diagnostic purposes.
 * This is a genuine, permanent capability gap for Claude Code (see
 * capability-matrix.v1.json), not something this adapter can work around.
 */
export function handlePreCompact(input: ClaudeHookInput, logger: (level: string, message: string) => void): null {
  if (!input.transcript_path) {
    logger("debug", "pre-compact: no transcript_path in hook input")
    return null
  }

  const calls = parseClaudeTranscript(input.transcript_path)
  const state = extractNexusState(calls, (m) => logger("debug", m))

  if (!state.sessionId && !state.projectId) {
    logger("debug", "No Nexus session/project detected in pre-compact transcript")
  } else {
    logger(
      "info",
      `Pre-compact: detected session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"} ` +
        "(not injectable — PreCompact does not support additionalContext, logged for diagnostics only)",
    )
  }

  return null
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
  const compactedText = cleanCompactedText(input.compact_summary ?? "")
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
    handlePreCompact(input, logger)
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

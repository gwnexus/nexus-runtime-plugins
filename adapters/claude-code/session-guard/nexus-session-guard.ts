#!/usr/bin/env node
/**
 * Nexus Session Guard — Claude Code adapter (ADR-C05, Track B2, Dispatch dc5fdf9a).
 *
 * Wires the runtime-agnostic core/session-guard/logic.ts state machine to
 * Claude Code's hook protocol. Unlike the OpenCode adapter, Claude Code
 * invokes a fresh process per hook event, so turn/trigger counters are
 * persisted to `.nexus/session-guard-state.json` between invocations via
 * core/state-store.ts.
 *
 * Capability matrix: `session_guard` = "partial" for Claude Code.
 * Disclosed gap: event granularity/ordering differs from OpenCode's
 * tool.execute.after + message.updated stream. UserPromptSubmit fires once
 * per user turn, which is a close but not perfectly identical semantic
 * match to OpenCode's per-message.updated dedup logic.
 *
 * CONFIRMED (2026-09-20, official hooks reference, see Dispatch `dc5fdf9a`
 * reply from nexus-app): `hookSpecificOutput.additionalContext` is the
 * correct field for both `PostToolUse` and `UserPromptSubmit` — it adds
 * supplementary text alongside the tool's actual result (exactly what a
 * reminder needs), unlike `updatedToolOutput` which replaces the result
 * entirely (used by headroom-intercept instead). No changes needed; this
 * adapter's approach matches the documented pattern as originally written.
 *
 * Fix (Dispatch 0e38cf7b review, 2026-09-24): Claude Code sends Nexus MCP
 * tool calls as `mcp__nexus__task_create`, `mcp__nexus__adr_create`, etc.,
 * not the OpenCode-style `nexus_task_create` this adapter's `PostToolUse`
 * matcher and `isTriggerTool()`/`DEFAULT_TRIGGER_MCP` check expect (same
 * root cause as the headroom-intercept tool-name-mismatch bug fixed
 * earlier in this dispatch). The matcher never fired for these tool names
 * at all, so session-guard never saw or reminded about them. Fixed with
 * the same `normalizeClaudeToolName()` approach used in the Claude Code
 * headroom-intercept adapter (kept local to this adapter; core stays
 * runtime-neutral).
 *
 * Hook configuration (.claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "UserPromptSubmit": [
 *         { "hooks": [{ "type": "command", "command": "node adapters/claude-code/session-guard/nexus-session-guard.ts user-prompt-submit" }] }
 *       ],
 *       "PostToolUse": [
 *         {
 *           "matcher": "Edit|Write|MultiEdit|Bash|nexus_task_create|nexus_adr_create|nexus_adr_decide|nexus_session_append|mcp__nexus__task_create|mcp__nexus__adr_create|mcp__nexus__adr_decide|mcp__nexus__session_append",
 *           "hooks": [{ "type": "command", "command": "node adapters/claude-code/session-guard/nexus-session-guard.ts post-tool-use" }]
 *         }
 *       ]
 *     }
 *   }
 */
import { createFileLogger } from "../../../core/logger.ts"
import { loadState, saveState } from "../../../core/state-store.ts"
import {
  PLUGIN_META,
  initialState,
  onUserTurn,
  evaluateToolCompletion,
  REMINDER_MESSAGE,
  type SessionGuardState,
} from "../../../core/session-guard/logic.ts"

export const STATE_FILE = "session-guard-state.json"

export interface ClaudeHookInput {
  hook_event_name?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
}

export type HookMode = "user-prompt-submit" | "post-tool-use"

/**
 * Normalize Claude Code's MCP tool name into the core logic's naming
 * convention (same mapping as the headroom-intercept adapter's
 * `normalizeClaudeToolName`, Dispatch 0e38cf7b): `mcp__nexus__X` -> `nexus_X`.
 * Native tools (`Edit`, `Write`, `Bash`, ...) pass through unchanged.
 */
export function normalizeClaudeToolName(toolName: string): string {
  const mcpMatch = toolName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/)
  if (!mcpMatch) return toolName
  const [, server, rest] = mcpMatch
  if (server === "nexus-headroom") return rest
  if (server === "nexus") return `nexus_${rest}`
  return toolName
}

/**
 * Pure(ish) hook handler — testable without spawning a process. Reads
 * persisted state, applies the core logic, persists updated state, and
 * returns the JSON payload (if any) that should be written to stdout.
 */
export function handleHookEvent(
  mode: string,
  input: ClaudeHookInput,
  fileLog: (level: string, message: string) => void,
): Record<string, unknown> | null {
  const directory = input.cwd ?? process.cwd()
  const state = loadState<SessionGuardState>(directory, STATE_FILE, initialState())

  if (mode === "user-prompt-submit") {
    onUserTurn(state)
    saveState(directory, STATE_FILE, state)
    fileLog("debug", `User turn ${state.lastUserTurnIndex} detected (UserPromptSubmit) — counters reset`)
    return null
  }

  if (mode === "post-tool-use") {
    const toolName = normalizeClaudeToolName(String(input.tool_name ?? ""))
    const toolInput = input.tool_input ?? {}
    const result = evaluateToolCompletion(state, toolName, toolInput)
    saveState(directory, STATE_FILE, state)

    if (result.action !== "remind") {
      fileLog("debug", `Tool ${toolName} — action=${result.action}`)
      return null
    }

    fileLog(
      "info",
      `REMINDER #${state.reminderCount} — tool=${toolName}, user=${state.lastUserTurnIndex}, append=${state.lastAppendTurnIndex}`,
    )

    // Confirmed field (2026-09-20): additionalContext surfaces supplementary
    // text to the model without replacing the tool's actual result.
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: REMINDER_MESSAGE,
      },
    }
  }

  fileLog("warn", `Unknown mode "${mode}" (expected user-prompt-submit|post-tool-use) — no-op`)
  return null
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf-8")
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ""
  const raw = await readStdin()

  let input: ClaudeHookInput = {}
  try {
    input = JSON.parse(raw || "{}")
  } catch {
    // Malformed/empty stdin — treat as no-op, do not block the tool call.
    process.exit(0)
  }

  const directory = input.cwd ?? process.cwd()
  const fileLog = createFileLogger(directory, "session-guard.log")
  const output = handleHookEvent(mode, input, fileLog)

  if (output) {
    process.stdout.write(JSON.stringify(output))
  }
  process.exit(0)
}

// Only run the CLI entrypoint when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Never crash/block on adapter errors — fail open.
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}\n`)
    process.exit(0)
  })
}

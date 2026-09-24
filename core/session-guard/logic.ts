/**
 * nexus-session-guard core logic (ADR-C05 core module).
 *
 * Runtime-agnostic state machine and trigger detection shared by the
 * OpenCode adapter (in-memory state, long-lived plugin instance) and the
 * Claude Code adapter (file-persisted state, one process per hook event).
 *
 * Detects code-changing tool completions and signals when a system
 * reminder should be injected because no session entry has been recorded
 * since the last user instruction.
 */

export const PLUGIN_META = {
  name: "nexus-session-guard",
  version: "1.1.3",
  description:
    "Detects code-changing tool completions and reminds the agent to call nexus_session_append before proceeding.",
} as const

/** Native code-editing tools that always trigger. */
export const DEFAULT_TRIGGER_TOOLS = new Set(["Edit", "Write", "MultiEdit"])

/** MCP tools that produce knowledge artifacts worth recording. */
export const DEFAULT_TRIGGER_MCP = new Set([
  "nexus_task_create",
  "nexus_adr_create",
  "nexus_adr_decide",
])

/**
 * Heuristic: does a Bash command look like a read-only operation?
 * We skip reminders for common read-only patterns to reduce noise.
 */
export const READ_ONLY_BASH_PATTERNS = [
  /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|ls|find|grep|rg|awk|sed\s+-n|echo|printf|which|type|command\s+-v|node\s+-e|node\s+--eval)/,
  /^\s*(git\s+(status|log|diff|show|branch|remote|tag))/,
  /^\s*(rtk\s+(gain|discover))/,
  /^\s*(npm\s+(ls|list|view|info|outdated|audit))/,
  /^\s*(npx\s+--yes\s+)/, // npx installs are typically read-ish
  /^\s*(pwd|hostname|uname|env|printenv|id|whoami)/,
]

export function isBashReadOnly(input: Record<string, unknown>): boolean {
  const cmd = String(input?.command ?? input?.cmd ?? "")
  if (!cmd) return true // empty command = no-op
  return READ_ONLY_BASH_PATTERNS.some((p) => p.test(cmd))
}

/** Minimum trigger tool calls before a reminder fires in a single user turn. */
export const TRIGGER_THRESHOLD = 3

export const REMINDER_MESSAGE =
  "<system-reminder>\n" +
  "[nexus-session-guard] You completed a code-changing operation but have not " +
  "appended a session entry since the last user instruction. Please call " +
  "nexus_session_append with a summary of what was just done before proceeding " +
  "to the next task.\n" +
  "</system-reminder>"

/** Runtime-agnostic session-guard state. Persisted differently per adapter. */
export interface SessionGuardState {
  lastUserTurnIndex: number
  lastAppendTurnIndex: number
  triggerCountThisTurn: number
  reminderFiredThisTurn: boolean
  reminderCount: number
  suppressCount: number
}

export function initialState(): SessionGuardState {
  return {
    lastUserTurnIndex: 0,
    lastAppendTurnIndex: 0,
    triggerCountThisTurn: 0,
    reminderFiredThisTurn: false,
    reminderCount: 0,
    suppressCount: 0,
  }
}

/** Call when a new user turn is detected. Mutates and returns the state. */
export function onUserTurn(state: SessionGuardState): SessionGuardState {
  state.lastUserTurnIndex++
  state.triggerCountThisTurn = 0
  state.reminderFiredThisTurn = false
  return state
}

export function isTriggerTool(toolName: string, input: Record<string, unknown>): boolean {
  if (DEFAULT_TRIGGER_TOOLS.has(toolName)) return true
  if (DEFAULT_TRIGGER_MCP.has(toolName)) return true
  if (toolName === "Bash" || toolName === "bash") {
    return !isBashReadOnly(input)
  }
  return false
}

export type TriggerResult =
  | { action: "session_append_recorded" }
  | { action: "not_a_trigger" }
  | { action: "suppressed_already_recorded" }
  | { action: "suppressed_below_threshold" }
  | { action: "suppressed_already_reminded" }
  | { action: "remind" }

/**
 * Evaluate a completed tool call against the current state.
 * Mutates `state` in place; returns the action taken so the adapter can
 * decide how to log/inject the reminder for its runtime.
 */
export function evaluateToolCompletion(
  state: SessionGuardState,
  toolName: string,
  input: Record<string, unknown>,
): TriggerResult {
  if (!toolName) return { action: "not_a_trigger" }

  if (toolName === "nexus_session_append") {
    state.lastAppendTurnIndex = state.lastUserTurnIndex
    return { action: "session_append_recorded" }
  }

  if (!isTriggerTool(toolName, input)) return { action: "not_a_trigger" }

  state.triggerCountThisTurn++

  if (state.lastUserTurnIndex <= state.lastAppendTurnIndex) {
    state.suppressCount++
    return { action: "suppressed_already_recorded" }
  }

  if (state.triggerCountThisTurn < TRIGGER_THRESHOLD) {
    return { action: "suppressed_below_threshold" }
  }

  if (state.reminderFiredThisTurn) {
    return { action: "suppressed_already_reminded" }
  }

  state.reminderFiredThisTurn = true
  state.reminderCount++
  return { action: "remind" }
}

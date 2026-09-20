import type { NexusState, NormalizedToolCall } from "./types.ts"

/** Safely parse a JSON string, returning null on failure. */
export function tryParseJson(str: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(str)
    return typeof parsed === "object" && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * Extract Nexus session/project state from a normalized list of tool
 * invocations (ADR-C05 core module) — runtime-agnostic. Both adapters
 * convert their own transcript format (OpenCode message parts vs. Claude
 * Code transcript JSONL) into `NormalizedToolCall[]` before calling this.
 */
export function extractNexusState(
  calls: NormalizedToolCall[],
  onDebug?: (message: string) => void,
): NexusState {
  const state: NexusState = {}

  for (const call of calls) {
    const { tool: toolName, args, result } = call
    if (!toolName) continue

    if (toolName === "nexus_session_create") {
      if (args.project_id) state.projectId = String(args.project_id)
      if (args.agent_id) state.agentId = String(args.agent_id)

      if (result) {
        onDebug?.(`nexus_session_create result keys: ${JSON.stringify(Object.keys(result))}`)
        if (result.id) {
          state.sessionId = String(result.id)
          onDebug?.(`Captured session ID from session_create result.id: ${state.sessionId}`)
        }
        if (result.session_id) {
          state.sessionId = String(result.session_id)
          onDebug?.(`Captured session ID from session_create result.session_id: ${state.sessionId}`)
        }
        if (result.title) state.sessionTitle = String(result.title)
      }
    }

    if (toolName === "nexus_session_append" && args.session_id) {
      state.sessionId = String(args.session_id)
      onDebug?.(`Captured session ID from session_append args: ${state.sessionId}`)
    }

    if (toolName.startsWith("nexus_") && args.project_id && !state.projectId) {
      state.projectId = String(args.project_id)
    }

    if (toolName !== "nexus_session_create" && result) {
      if (result.session_id) state.sessionId = String(result.session_id)
      if (result.title) state.sessionTitle = String(result.title)
    }
  }

  onDebug?.(`extractNexusState result: ${JSON.stringify(state)}`)
  return state
}

/** Build context lines for the compaction prompt. */
export function buildNexusContext(state: NexusState): string {
  const lines: string[] = [
    "## Nexus Platform Session Context",
    "",
    "This conversation is tracked in the Nexus platform. Preserve the following state:",
    "",
  ]

  if (state.sessionId) lines.push(`- **Active Nexus Session**: \`${state.sessionId}\``)
  if (state.sessionTitle) lines.push(`- **Session Title**: ${state.sessionTitle}`)
  if (state.projectId) lines.push(`- **Project ID**: \`${state.projectId}\``)
  if (state.agentId) lines.push(`- **Agent ID**: ${state.agentId}`)

  lines.push("")
  lines.push("When resuming after compaction:")
  lines.push("- Continue using the same Nexus session ID for `nexus_session_append` calls")
  lines.push("- Do NOT create a new session — the existing one is still active")
  lines.push("- Reference the project ID when making MCP tool calls")
  lines.push("- Check the todo list and Nexus task state for pending work")

  return lines.join("\n")
}

/**
 * Post-compaction summary text cleanup, shared between adapters:
 *  - strips leading markdown separators (---) Claude often prepends
 *  - shifts headings down by 2 levels so they nest under an H3 wrapper
 */
export function cleanCompactedText(text: string): string {
  let out = text.replace(/^(\s*---\s*\n?)+/, "").trimStart()
  out = out.replace(/^(#{2,6})\s/gm, (_match, hashes: string) => {
    const newLevel = Math.min(hashes.length + 2, 6)
    return "#".repeat(newLevel) + " "
  })
  return out
}

/** Build the final compaction-entry summary posted to the Nexus session. */
export function buildCompactionSummary(pluginVersion: string, timeLabel: string, compactedText: string): string {
  return compactedText
    ? `## Compaction at ${timeLabel}\n\nContext preserved via nexus-compaction-plus v${pluginVersion}.\n\n### Agent Summary\n\n${compactedText}`
    : `## Compaction at ${timeLabel}\n\nContext preserved via nexus-compaction-plus v${pluginVersion}.`
}

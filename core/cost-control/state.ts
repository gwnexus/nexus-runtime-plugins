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
 * invocations (ADR-C05 core module) — runtime-agnostic.
 */
export function extractNexusState(calls: NormalizedToolCall[], onDebug?: (message: string) => void): NexusState {
  const state: NexusState = {}

  for (const call of calls) {
    const { tool: toolName, args, result } = call
    if (!toolName) continue

    if (toolName === "nexus_session_create") {
      if (args.project_id) state.projectId = String(args.project_id)
      if (args.agent_id) state.agentId = String(args.agent_id)
      if (result?.id) state.sessionId = String(result.id)
      if (result?.session_id) state.sessionId = String(result.session_id)
    }
    if (toolName === "nexus_session_append" && args.session_id) {
      state.sessionId = String(args.session_id)
    }
    if (toolName.startsWith("nexus_") && args.project_id && !state.projectId) {
      state.projectId = String(args.project_id)
    }
    if (toolName !== "nexus_session_create" && result) {
      if (result.session_id) state.sessionId = String(result.session_id)
    }
  }

  onDebug?.(`extractNexusState: ${JSON.stringify(state)}`)
  return state
}

import { describe, it, expect } from "vitest"
import { tryParseJson, extractNexusState } from "./state.ts"
import type { NormalizedToolCall } from "./types.ts"

describe("cost-control core state extraction", () => {
  it("tryParseJson returns null for invalid JSON", () => {
    expect(tryParseJson("not json")).toBeNull()
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("extracts session ID and project ID from nexus_session_create", () => {
    const calls: NormalizedToolCall[] = [
      { tool: "nexus_session_create", args: { project_id: "proj-1", agent_id: "opencode" }, result: { id: "sess-1" } },
    ]
    const state = extractNexusState(calls)
    expect(state.sessionId).toBe("sess-1")
    expect(state.projectId).toBe("proj-1")
    expect(state.agentId).toBe("opencode")
  })

  it("extracts session ID from nexus_session_append args", () => {
    const calls: NormalizedToolCall[] = [
      { tool: "nexus_session_append", args: { session_id: "sess-from-append" }, result: null },
    ]
    expect(extractNexusState(calls).sessionId).toBe("sess-from-append")
  })

  it("extracts project ID from any nexus_ tool call", () => {
    const calls: NormalizedToolCall[] = [{ tool: "nexus_task_list", args: { project_id: "proj-from-task" }, result: null }]
    expect(extractNexusState(calls).projectId).toBe("proj-from-task")
  })

  it("returns an empty state when no calls are present", () => {
    expect(extractNexusState([])).toEqual({})
  })
})

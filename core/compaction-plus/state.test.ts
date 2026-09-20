import { describe, it, expect } from "vitest"
import { tryParseJson, extractNexusState, buildNexusContext, cleanCompactedText, buildCompactionSummary } from "./state.ts"
import type { NormalizedToolCall } from "./types.ts"

describe("compaction-plus core state extraction", () => {
  it("tryParseJson returns null for invalid JSON", () => {
    expect(tryParseJson("not json")).toBeNull()
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("extracts session ID and project ID from nexus_session_create", () => {
    const calls: NormalizedToolCall[] = [
      {
        tool: "nexus_session_create",
        args: { project_id: "proj-123", agent_id: "opencode" },
        result: { id: "session-abc", title: "Test Session" },
      },
    ]
    const state = extractNexusState(calls)
    expect(state.sessionId).toBe("session-abc")
    expect(state.projectId).toBe("proj-123")
    expect(state.agentId).toBe("opencode")
    expect(state.sessionTitle).toBe("Test Session")
  })

  it("extracts session ID from nexus_session_append args", () => {
    const calls: NormalizedToolCall[] = [
      { tool: "nexus_session_append", args: { session_id: "sess-from-append" }, result: null },
    ]
    const state = extractNexusState(calls)
    expect(state.sessionId).toBe("sess-from-append")
  })

  it("extracts project ID from any nexus_ tool call", () => {
    const calls: NormalizedToolCall[] = [
      { tool: "nexus_task_list", args: { project_id: "proj-from-task" }, result: null },
    ]
    const state = extractNexusState(calls)
    expect(state.projectId).toBe("proj-from-task")
  })

  it("does not extract anything when no calls are present", () => {
    expect(extractNexusState([])).toEqual({})
  })

  it("buildNexusContext includes session, project, and agent details", () => {
    const context = buildNexusContext({ sessionId: "s1", projectId: "p1", agentId: "a1", sessionTitle: "T1" })
    expect(context).toContain("Nexus Platform Session Context")
    expect(context).toContain("s1")
    expect(context).toContain("p1")
    expect(context).toContain("a1")
    expect(context).toContain("T1")
  })

  it("cleanCompactedText strips leading separators and shifts headings", () => {
    const raw = "---\n## Goal\n\nDo the thing.\n### Done\n\nDone it."
    const cleaned = cleanCompactedText(raw)
    expect(cleaned.startsWith("---")).toBe(false)
    expect(cleaned).toContain("#### Goal")
    expect(cleaned).toContain("##### Done")
  })

  it("buildCompactionSummary includes the agent summary when text is present", () => {
    const summary = buildCompactionSummary("1.8.1", "14:00", "Some summary text")
    expect(summary).toContain("nexus-compaction-plus v1.8.1")
    expect(summary).toContain("### Agent Summary")
    expect(summary).toContain("Some summary text")
  })

  it("buildCompactionSummary omits the agent summary section when text is empty", () => {
    const summary = buildCompactionSummary("1.8.1", "14:00", "")
    expect(summary).not.toContain("### Agent Summary")
  })
})

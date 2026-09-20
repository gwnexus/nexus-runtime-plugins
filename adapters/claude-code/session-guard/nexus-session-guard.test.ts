import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock core/state-store to avoid real file system writes; keep an in-memory
// map keyed by directory+file so state persists across calls within a test.
const memory = new Map<string, unknown>()
vi.mock("../../../core/state-store.ts", () => ({
  loadState: vi.fn((directory: string, fileName: string, fallback: unknown) => {
    const key = `${directory}:${fileName}`
    return memory.has(key) ? memory.get(key) : fallback
  }),
  saveState: vi.fn((directory: string, fileName: string, state: unknown) => {
    memory.set(`${directory}:${fileName}`, state)
  }),
}))

vi.mock("../../../core/logger.ts", () => ({
  createFileLogger: () => vi.fn(),
}))

import { handleHookEvent } from "./nexus-session-guard.ts"

describe("session-guard Claude Code adapter", () => {
  const fileLog = vi.fn()
  const cwd = "/tmp/test-project"

  beforeEach(() => {
    memory.clear()
    fileLog.mockClear()
  })

  it("user-prompt-submit increments the turn counter (no stdout payload)", () => {
    const result = handleHookEvent("user-prompt-submit", { cwd }, fileLog)
    expect(result).toBeNull()
  })

  it("post-tool-use does not remind below threshold", () => {
    handleHookEvent("user-prompt-submit", { cwd }, fileLog)
    const r1 = handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    const r2 = handleHookEvent("post-tool-use", { cwd, tool_name: "Write" }, fileLog)
    expect(r1).toBeNull()
    expect(r2).toBeNull()
  })

  it("post-tool-use reminds at threshold via hookSpecificOutput.additionalContext", () => {
    handleHookEvent("user-prompt-submit", { cwd }, fileLog)
    handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    const r3 = handleHookEvent("post-tool-use", { cwd, tool_name: "MultiEdit" }, fileLog)

    expect(r3).not.toBeNull()
    expect((r3 as any).hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect((r3 as any).hookSpecificOutput.additionalContext).toContain("[nexus-session-guard]")
  })

  it("nexus_session_append suppresses further reminders for the same turn", () => {
    handleHookEvent("user-prompt-submit", { cwd }, fileLog)
    handleHookEvent("post-tool-use", { cwd, tool_name: "nexus_session_append" }, fileLog)

    for (const _ of [1, 2, 3, 4]) {
      const r = handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
      expect(r).toBeNull()
    }
  })

  it("does not remind for read-only Bash commands", () => {
    handleHookEvent("user-prompt-submit", { cwd }, fileLog)
    const r1 = handleHookEvent(
      "post-tool-use",
      { cwd, tool_name: "Bash", tool_input: { command: "git status" } },
      fileLog,
    )
    const r2 = handleHookEvent(
      "post-tool-use",
      { cwd, tool_name: "Bash", tool_input: { command: "cat foo.txt" } },
      fileLog,
    )
    expect(r1).toBeNull()
    expect(r2).toBeNull()
  })

  it("reminds for mutating Bash commands at threshold", () => {
    handleHookEvent("user-prompt-submit", { cwd }, fileLog)
    handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    const r3 = handleHookEvent(
      "post-tool-use",
      { cwd, tool_name: "Bash", tool_input: { command: "rm -rf /tmp/foo" } },
      fileLog,
    )
    expect((r3 as any).hookSpecificOutput.additionalContext).toContain("system-reminder")
  })

  it("state persists across separate handler invocations (simulating separate processes)", () => {
    handleHookEvent("user-prompt-submit", { cwd }, fileLog)
    handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    // Second "process" invocation for the same turn — counter should carry over.
    handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    const r3 = handleHookEvent("post-tool-use", { cwd, tool_name: "Edit" }, fileLog)
    expect((r3 as any).hookSpecificOutput.additionalContext).toContain("[nexus-session-guard]")
  })

  it("returns null and logs a warning for an unknown mode", () => {
    const r = handleHookEvent("some-unknown-mode", { cwd }, fileLog)
    expect(r).toBeNull()
    expect(fileLog).toHaveBeenCalledWith("warn", expect.stringContaining("Unknown mode"))
  })
})

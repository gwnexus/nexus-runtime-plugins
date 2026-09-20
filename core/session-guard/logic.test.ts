import { describe, it, expect } from "vitest"
import {
  initialState,
  onUserTurn,
  evaluateToolCompletion,
  isTriggerTool,
  isBashReadOnly,
} from "./logic.ts"

describe("session-guard core logic", () => {
  it("starts with zeroed counters", () => {
    const s = initialState()
    expect(s.lastUserTurnIndex).toBe(0)
    expect(s.lastAppendTurnIndex).toBe(0)
    expect(s.reminderCount).toBe(0)
  })

  it("onUserTurn increments turn index and resets per-turn counters", () => {
    const s = initialState()
    s.triggerCountThisTurn = 2
    s.reminderFiredThisTurn = true
    onUserTurn(s)
    expect(s.lastUserTurnIndex).toBe(1)
    expect(s.triggerCountThisTurn).toBe(0)
    expect(s.reminderFiredThisTurn).toBe(false)
  })

  it("identifies trigger tools correctly", () => {
    expect(isTriggerTool("Edit", {})).toBe(true)
    expect(isTriggerTool("Read", {})).toBe(false)
    expect(isTriggerTool("nexus_task_create", {})).toBe(true)
    expect(isTriggerTool("Bash", { command: "rm -rf /tmp/x" })).toBe(true)
    expect(isTriggerTool("Bash", { command: "git status" })).toBe(false)
  })

  it("isBashReadOnly treats empty command as read-only (no-op)", () => {
    expect(isBashReadOnly({})).toBe(true)
  })

  it("does not remind before threshold, reminds once at threshold, then suppresses", () => {
    const s = initialState()
    onUserTurn(s)

    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("suppressed_below_threshold")
    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("suppressed_below_threshold")
    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("remind")
    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("suppressed_already_reminded")
  })

  it("session_append resets the need-to-remind window for the current turn", () => {
    const s = initialState()
    onUserTurn(s)
    evaluateToolCompletion(s, "nexus_session_append", {})
    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("suppressed_already_recorded")
  })

  it("reminds again after a new user turn", () => {
    const s = initialState()
    onUserTurn(s)
    evaluateToolCompletion(s, "nexus_session_append", {})

    onUserTurn(s)
    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("suppressed_below_threshold")
    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("suppressed_below_threshold")
    expect(evaluateToolCompletion(s, "Edit", {}).action).toBe("remind")
  })

  it("returns not_a_trigger for empty or non-trigger tool names", () => {
    const s = initialState()
    onUserTurn(s)
    expect(evaluateToolCompletion(s, "", {}).action).toBe("not_a_trigger")
    expect(evaluateToolCompletion(s, "Read", {}).action).toBe("not_a_trigger")
  })
})

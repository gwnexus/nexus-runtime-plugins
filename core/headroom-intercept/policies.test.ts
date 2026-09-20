import { describe, it, expect } from "vitest"
import { lookupPolicy, POLICIES, DEFAULT_MIN_TOKENS } from "./policies.ts"

describe("headroom-intercept core policies", () => {
  it("returns exact policy match", () => {
    const { policy, noMatch } = lookupPolicy("nexus_kb_memory")
    expect(noMatch).toBe(false)
    expect(policy?.action).toBe("compress")
    expect(policy?.profile).toBe("reference-data")
  })

  it("falls back to passthrough for unknown nexus_ prefixed tools", () => {
    const { policy, noMatch } = lookupPolicy("nexus_some_future_tool")
    expect(noMatch).toBe(false)
    expect(policy?.action).toBe("passthrough")
    expect(policy?.reason).toBe("no-explicit-policy")
  })

  it("falls back to passthrough for unknown headroom_ prefixed tools", () => {
    const { policy, noMatch } = lookupPolicy("headroom_some_future_tool")
    expect(noMatch).toBe(false)
    expect(policy?.action).toBe("passthrough")
  })

  it("returns noMatch for tools with no nexus_/headroom_ prefix", () => {
    const { policy, noMatch } = lookupPolicy("Read")
    expect(noMatch).toBe(true)
    expect(policy).toBeNull()
  })

  it("classifies known write-operation tools as passthrough", () => {
    for (const tool of ["nexus_session_append", "nexus_task_create", "nexus_adr_create"]) {
      const { policy } = lookupPolicy(tool)
      expect(policy?.action).toBe("passthrough")
      expect(policy?.reason).toBe("write-operation")
    }
  })

  it("classifies bash/read/write/edit as skip", () => {
    for (const tool of ["bash", "shell", "read", "write", "edit", "glob", "grep"]) {
      const { policy } = lookupPolicy(tool)
      expect(policy?.action).toBe("skip")
    }
  })

  it("has a non-empty policy table with a sane default threshold", () => {
    expect(Object.keys(POLICIES).length).toBeGreaterThan(30)
    expect(DEFAULT_MIN_TOKENS).toBe(2000)
  })
})

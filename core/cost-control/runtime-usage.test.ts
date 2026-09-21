import { describe, it, expect } from "vitest"
import { emptyRuntimeUsage, buildRuntimeCostEntry } from "./runtime-usage.ts"

describe("cost-control core runtime-usage", () => {
  it("builds an empty usage record with zeroed counters", () => {
    const usage = emptyRuntimeUsage()
    expect(usage).toEqual({
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      totalTokens: 0,
      totalMessages: 0,
      models: [],
    })
  })

  it("builds a token-only cost entry with costUsd explicitly null, not zero", () => {
    const usage = {
      tokensInput: 100,
      tokensOutput: 40,
      tokensCacheRead: 5,
      tokensCacheWrite: 2,
      totalTokens: 140,
      totalMessages: 3,
      models: ["claude-sonnet-5"],
    }

    const entry = buildRuntimeCostEntry("nexus-sess-1", usage)

    expect(entry.costUsd).toBeNull()
    expect(entry.costSource).toBe("runtime")
    expect(entry.totalRequests).toBe(0)
    expect(entry.totalMessages).toBe(3)
    expect(entry.totalTokens).toBe(140)
    expect(entry.models).toEqual(["claude-sonnet-5"])
    expect(entry.nexusSessionId).toBe("nexus-sess-1")
  })
})

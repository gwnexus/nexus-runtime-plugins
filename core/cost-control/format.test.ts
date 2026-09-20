import { describe, it, expect } from "vitest"
import { formatCostSummary } from "./format.ts"
import type { HeliconeSessionCost } from "./types.ts"

describe("cost-control core format", () => {
  const cost: HeliconeSessionCost = {
    nexusSessionId: "sess-1",
    totalRequests: 5,
    tokensInput: 1000,
    tokensOutput: 500,
    tokensCacheRead: 100,
    tokensCacheWrite: 50,
    totalTokens: 1500,
    costUsd: 0.012345,
    models: ["claude-sonnet-5"],
    queriedAt: new Date().toISOString(),
  }

  it("includes all metrics and the plugin version", () => {
    const summary = formatCostSummary(cost, "1.0.1")
    expect(summary).toContain("nexus-cost-control v1.0.1")
    expect(summary).toContain(cost.tokensInput.toLocaleString())
    expect(summary).toContain(cost.totalTokens.toLocaleString())
    expect(summary).toContain("$0.012345")
    expect(summary).toContain("claude-sonnet-5")
  })

  it("omits the models row when no models are present", () => {
    const summary = formatCostSummary({ ...cost, models: [] }, "1.0.1")
    expect(summary).not.toContain("| Models |")
  })
})

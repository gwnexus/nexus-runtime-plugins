import { describe, it, expect, vi, beforeEach } from "vitest"
import { appendCostEntry } from "./api.ts"
import type { HeliconeSessionCost } from "./types.ts"

describe("cost-control core api", () => {
  const nexusConfig = { apiUrl: "https://nexus.example.com", token: "tok-123" }
  const pluginMeta = { name: "nexus-cost-control", version: "1.0.1" }
  const cost: HeliconeSessionCost = {
    nexusSessionId: "sess-1",
    totalRequests: 1,
    tokensInput: 100,
    tokensOutput: 50,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    totalTokens: 150,
    costUsd: 0.001,
    models: ["claude-sonnet-5"],
    queriedAt: new Date().toISOString(),
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("posts a session_append payload with entry_type=cost_snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" })
    vi.stubGlobal("fetch", fetchMock)

    await appendCostEntry(nexusConfig, "sess-1", cost, pluginMeta)

    expect(fetchMock).toHaveBeenCalledWith(
      "https://nexus.example.com/api/mcp/sessions",
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.entry_type).toBe("cost_snapshot")
    expect(body.session_id).toBe("sess-1")
    const metadata = JSON.parse(body.metadata)
    expect(metadata.total_tokens).toBe(150)
    expect(metadata.plugin).toBe("nexus-cost-control")
  })

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "server error" }))
    await expect(appendCostEntry(nexusConfig, "sess-1", cost, pluginMeta)).rejects.toThrow("Nexus API 500")
  })

  it("defaults cost_source to helicone when the field is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" })
    vi.stubGlobal("fetch", fetchMock)

    await appendCostEntry(nexusConfig, "sess-1", cost, pluginMeta)

    const metadata = JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).metadata)
    expect(metadata.cost_source).toBe("helicone")
  })

  it("writes cost_usd: null and cost_source: runtime for runtime-sourced entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" })
    vi.stubGlobal("fetch", fetchMock)

    const runtimeCost: HeliconeSessionCost = {
      ...cost,
      totalRequests: 0,
      costUsd: null,
      costSource: "runtime",
      totalMessages: 4,
    }

    await appendCostEntry(nexusConfig, "sess-1", runtimeCost, pluginMeta)

    const metadata = JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).metadata)
    expect(metadata.cost_usd).toBeNull()
    expect(metadata.cost_source).toBe("runtime")
    expect(metadata.total_messages).toBe(4)
  })
})

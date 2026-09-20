import { describe, it, expect, vi, beforeEach } from "vitest"
import { queryHeliconeSession } from "./helicone.ts"

describe("cost-control core helicone client", () => {
  const config = { apiKey: "sk-helicone-123" }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("aggregates token counts and cost across requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              request: {
                model: "claude-sonnet-5",
                prompt_tokens: 100,
                completion_tokens: 50,
                prompt_cache_read_tokens: 10,
                prompt_cache_write_tokens: 5,
                helicone_cost: 0.001234,
              },
            },
            {
              request: {
                model: "claude-sonnet-5",
                prompt_tokens: 200,
                completion_tokens: 80,
                helicone_cost: 0.002,
              },
            },
          ],
        }),
      }),
    )

    const cost = await queryHeliconeSession(config, "nexus-sess-1")
    expect(cost).not.toBeNull()
    expect(cost!.totalRequests).toBe(2)
    expect(cost!.tokensInput).toBe(300)
    expect(cost!.tokensOutput).toBe(130)
    expect(cost!.totalTokens).toBe(430)
    expect(cost!.models).toEqual(["claude-sonnet-5"])
    expect(cost!.costUsd).toBeCloseTo(0.003234, 6)
  })

  it("returns null when there are no requests for the session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }))
    const cost = await queryHeliconeSession(config, "nexus-sess-empty")
    expect(cost).toBeNull()
  })

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" }))
    const cost = await queryHeliconeSession(config, "nexus-sess-1")
    expect(cost).toBeNull()
  })

  it("returns null and does not throw on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    await expect(queryHeliconeSession(config, "nexus-sess-1")).resolves.toBeNull()
  })
})

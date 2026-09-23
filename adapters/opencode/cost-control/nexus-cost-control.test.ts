import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock @opencode-ai/plugin
vi.mock("@opencode-ai/plugin", () => ({
  tool: (def: any) => def,
}))

// Mock fs
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not found")
    }),
  }
})

import { NexusCostControl } from "./nexus-cost-control.ts"

vi.mock("../../../core/cost-control/config.ts", () => ({
  getNexusConfig: vi.fn(),
  getHeliconeConfig: vi.fn(),
}))

vi.mock("../../../core/cost-control/helicone.ts", () => ({
  queryHeliconeSession: vi.fn(),
}))

vi.mock("../../../core/cost-control/api.ts", () => ({
  appendCostEntry: vi.fn().mockResolvedValue(undefined),
}))

import { getNexusConfig, getHeliconeConfig } from "../../../core/cost-control/config.ts"
import { queryHeliconeSession } from "../../../core/cost-control/helicone.ts"
import { appendCostEntry } from "../../../core/cost-control/api.ts"

function makeClient() {
  return {
    app: { log: vi.fn().mockResolvedValue(undefined) },
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
}

describe("NexusCostControl", () => {
  let hooks: any
  let client: ReturnType<typeof makeClient>

  beforeEach(async () => {
    client = makeClient()
    vi.mocked(getNexusConfig).mockReset()
    vi.mocked(getHeliconeConfig).mockReset()
    vi.mocked(queryHeliconeSession).mockReset()
    vi.mocked(appendCostEntry).mockReset().mockResolvedValue(undefined)
    hooks = await NexusCostControl({ client, directory: "/tmp/test-project" } as any)
  })

  it("should return expected hook structure", () => {
    expect(hooks.event).toBeTypeOf("function")
    expect(hooks.tool.nexus_cost_summary).toBeDefined()
    expect(hooks.tool.nexus_show_plugins).toBeDefined()
  })

  describe("nexus_show_plugins tool", () => {
    it("should return formatted plugin info", async () => {
      const result = await hooks.tool.nexus_show_plugins.execute()
      expect(result).toContain("nexus-cost-control")
      expect(result).toContain("Nexus Plugins")
      expect(result).toContain("session.idle")
      expect(result).toContain("nexus_cost_summary")
    })
  })

  describe("nexus_cost_summary tool", () => {
    it("reports no active session when none is found (no Helicone config needed)", async () => {
      const result = await hooks.tool.nexus_cost_summary.execute()
      expect(result).toContain("No active Nexus session found")
    })
  })

  describe("event handler", () => {
    it("should ignore non-session.idle events", async () => {
      await hooks.event({ event: { type: "message.created" } })
      await hooks.event({ event: { type: "session.compacted" } })
      // No error, should just return
    })

    it("should return early on session.idle when no Helicone config", async () => {
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "oc-sess-1" },
        },
      })
      // Should not fetch messages (no config)
      expect(client.session.messages).not.toHaveBeenCalled()
    })

    it("falls back to runtime token aggregation when Helicone is configured but returns no data", async () => {
      const nexusConfig = { apiUrl: "https://nexus.example.com", token: "tok" }
      const heliconeConfig = { apiKey: "sk-helicone" }
      vi.mocked(getNexusConfig).mockReturnValue(nexusConfig)
      vi.mocked(getHeliconeConfig).mockReturnValue(heliconeConfig)
      vi.mocked(queryHeliconeSession).mockResolvedValue(null)
      hooks = await NexusCostControl({ client, directory: "/tmp/test-project" } as any)

      client.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              role: "assistant",
              modelID: "claude-opus-4",
              tokens: { input: 200, output: 80, cache: { read: 10, write: 5 } },
            },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_append",
                state: { status: "completed", input: { session_id: "nexus-sess-1" } },
              },
            ],
          },
        ],
      })

      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: "oc-sess-1" } },
      })

      expect(appendCostEntry).toHaveBeenCalledWith(
        nexusConfig,
        "nexus-sess-1",
        expect.objectContaining({ costUsd: null, costSource: "runtime", totalTokens: 280, totalMessages: 1 }),
        expect.objectContaining({ name: "nexus-cost-control" }),
        expect.any(Function),
      )
    })

    it("skips entirely on session.idle when Helicone has no data and no assistant messages exist", async () => {
      const nexusConfig = { apiUrl: "https://nexus.example.com", token: "tok" }
      const heliconeConfig = { apiKey: "sk-helicone" }
      vi.mocked(getNexusConfig).mockReturnValue(nexusConfig)
      vi.mocked(getHeliconeConfig).mockReturnValue(heliconeConfig)
      vi.mocked(queryHeliconeSession).mockResolvedValue(null)
      hooks = await NexusCostControl({ client, directory: "/tmp/test-project" } as any)

      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_append",
                state: { status: "completed", input: { session_id: "nexus-sess-1" } },
              },
            ],
          },
        ],
      })
      // Assistant message present but with no tokens field at all is still counted
      // as a message; to truly hit the "skip" branch, drop the assistant role.
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "user" },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_append",
                state: { status: "completed", input: { session_id: "nexus-sess-1" } },
              },
            ],
          },
        ],
      })

      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: "oc-sess-1" } },
      })

      expect(appendCostEntry).not.toHaveBeenCalled()
    })
  })

  describe("state extraction", () => {
    it("should extract session from nexus_session_create result and run native aggregation with no Helicone config", async () => {
      // This tests the extractNexusState function indirectly via session.compacting
      // NexusCostControl uses the same extractNexusState as compaction-plus
      // We verify via the nexus_cost_summary tool which fetches messages
      client.session.list.mockResolvedValue({
        data: [{ id: "oc-session-1" }],
      })
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_create",
                state: {
                  status: "completed",
                  input: { project_id: "proj-1" },
                  output: JSON.stringify({ id: "nexus-sess-1" }),
                },
              },
            ],
          },
        ],
      })

      // No Helicone config: the tool now runs native aggregation unconditionally
      // instead of returning "not configured".
      const result = await hooks.tool.nexus_cost_summary.execute()
      expect(result).toContain("Token & Cost Summary")
      expect(result).toContain("n/a (subscription — not metered)")
    })

    it("prefers Helicone data as enrichment when it is configured and returns data", async () => {
      const heliconeConfig = { apiKey: "sk-helicone" }
      vi.mocked(getHeliconeConfig).mockReturnValue(heliconeConfig)
      vi.mocked(queryHeliconeSession).mockResolvedValue({
        nexusSessionId: "nexus-sess-1",
        totalRequests: 3,
        tokensInput: 500,
        tokensOutput: 200,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        totalTokens: 700,
        costUsd: 0.0042,
        costSource: "helicone",
        models: ["claude-sonnet-5"],
        queriedAt: new Date().toISOString(),
      })
      hooks = await NexusCostControl({ client, directory: "/tmp/test-project" } as any)

      client.session.list.mockResolvedValue({ data: [{ id: "oc-session-1" }] })
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_create",
                state: { status: "completed", input: {}, output: JSON.stringify({ id: "nexus-sess-1" }) },
              },
            ],
          },
        ],
      })

      const result = await hooks.tool.nexus_cost_summary.execute()
      expect(result).toContain("$0.004200")
      expect(queryHeliconeSession).toHaveBeenCalledWith(
        heliconeConfig,
        "nexus-sess-1",
        expect.any(Function),
      )
    })
  })
})

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  }
})

const stateMemory = new Map<string, unknown>()
vi.mock("../../../core/state-store.ts", () => ({
  loadState: vi.fn((directory: string, fileName: string, fallback: unknown) => {
    const key = `${directory}:${fileName}`
    return stateMemory.has(key) ? stateMemory.get(key) : fallback
  }),
  saveState: vi.fn((directory: string, fileName: string, state: unknown) => {
    stateMemory.set(`${directory}:${fileName}`, state)
  }),
}))

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

import { existsSync, readFileSync } from "node:fs"
import { getNexusConfig, getHeliconeConfig } from "../../../core/cost-control/config.ts"
import { queryHeliconeSession } from "../../../core/cost-control/helicone.ts"
import { appendCostEntry } from "../../../core/cost-control/api.ts"
import { parseClaudeTranscript, handleStop } from "./nexus-cost-control.ts"

function transcriptLine(entry: unknown): string {
  return JSON.stringify(entry)
}

const nexusConfig = { apiUrl: "https://nexus.example.com", token: "tok" }
const heliconeConfig = { apiKey: "sk-helicone" }

describe("cost-control Claude Code adapter", () => {
  let logs: Array<[string, string]>
  const logger = (level: string, message: string) => logs.push([level, message])

  beforeEach(() => {
    logs = []
    stateMemory.clear()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(getNexusConfig).mockReturnValue(null)
    vi.mocked(getHeliconeConfig).mockReturnValue(null)
    vi.mocked(queryHeliconeSession).mockResolvedValue(null)
    vi.mocked(appendCostEntry).mockClear()
  })

  describe("parseClaudeTranscript", () => {
    it("returns an empty array when the transcript file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false)
      expect(parseClaudeTranscript("/tmp/missing.jsonl")).toEqual([])
    })

    it("pairs tool_use blocks with their tool_result by id", () => {
      const lines = [
        transcriptLine({
          message: {
            content: [{ type: "tool_use", id: "c1", name: "nexus_session_create", input: { project_id: "p1" } }],
          },
        }),
        transcriptLine({
          message: {
            content: [
              { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: JSON.stringify({ id: "s1" }) }] },
            ],
          },
        }),
      ]
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"))

      const calls = parseClaudeTranscript("/tmp/t.jsonl")
      expect(calls).toHaveLength(1)
      expect(calls[0].tool).toBe("nexus_session_create")
      expect(calls[0].result).toEqual({ id: "s1" })
    })
  })

  describe("handleStop", () => {
    it("skips when Nexus or Helicone config is missing", async () => {
      await handleStop({ cwd: "/tmp/proj" }, logger)
      expect(queryHeliconeSession).not.toHaveBeenCalled()
    })

    it("skips when no transcript_path is provided", async () => {
      vi.mocked(getNexusConfig).mockReturnValue(nexusConfig)
      vi.mocked(getHeliconeConfig).mockReturnValue(heliconeConfig)
      await handleStop({ cwd: "/tmp/proj" }, logger)
      expect(queryHeliconeSession).not.toHaveBeenCalled()
    })

    it("skips when no Nexus session ID is found in the transcript", async () => {
      vi.mocked(getNexusConfig).mockReturnValue(nexusConfig)
      vi.mocked(getHeliconeConfig).mockReturnValue(heliconeConfig)
      vi.mocked(readFileSync).mockReturnValue("")
      await handleStop({ cwd: "/tmp/proj", transcript_path: "/tmp/t.jsonl" }, logger)
      expect(queryHeliconeSession).not.toHaveBeenCalled()
    })

    it("records a cost entry when Helicone data is found", async () => {
      vi.mocked(getNexusConfig).mockReturnValue(nexusConfig)
      vi.mocked(getHeliconeConfig).mockReturnValue(heliconeConfig)
      const lines = [
        transcriptLine({
          message: { content: [{ type: "tool_use", id: "c1", name: "nexus_session_create", input: {} }] },
        }),
        transcriptLine({
          message: {
            content: [
              { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: JSON.stringify({ id: "s1" }) }] },
            ],
          },
        }),
      ]
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"))
      vi.mocked(queryHeliconeSession).mockResolvedValue({
        nexusSessionId: "s1",
        totalRequests: 1,
        tokensInput: 100,
        tokensOutput: 50,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        totalTokens: 150,
        costUsd: 0.001,
        models: ["claude-sonnet-5"],
        queriedAt: new Date().toISOString(),
      })

      await handleStop({ cwd: "/tmp/proj", transcript_path: "/tmp/t.jsonl" }, logger)

      expect(appendCostEntry).toHaveBeenCalledWith(
        nexusConfig,
        "s1",
        expect.objectContaining({ totalTokens: 150 }),
        { name: "nexus-cost-control", version: "1.0.1" },
        expect.any(Function),
      )
    })

    it("skips a second recording within the debounce window (no token delta)", async () => {
      vi.mocked(getNexusConfig).mockReturnValue(nexusConfig)
      vi.mocked(getHeliconeConfig).mockReturnValue(heliconeConfig)
      const lines = [
        transcriptLine({
          message: { content: [{ type: "tool_use", id: "c1", name: "nexus_session_create", input: {} }] },
        }),
        transcriptLine({
          message: {
            content: [
              { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: JSON.stringify({ id: "s1" }) }] },
            ],
          },
        }),
      ]
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"))
      const sameCost = {
        nexusSessionId: "s1",
        totalRequests: 1,
        tokensInput: 100,
        tokensOutput: 50,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        totalTokens: 150,
        costUsd: 0.001,
        models: [],
        queriedAt: new Date().toISOString(),
      }
      vi.mocked(queryHeliconeSession).mockResolvedValue(sameCost)

      await handleStop({ cwd: "/tmp/proj", transcript_path: "/tmp/t.jsonl" }, logger)
      expect(appendCostEntry).toHaveBeenCalledTimes(1)

      // Second call within the debounce window with identical token count — should be skipped
      await handleStop({ cwd: "/tmp/proj", transcript_path: "/tmp/t.jsonl" }, logger)
      expect(appendCostEntry).toHaveBeenCalledTimes(1)
    })
  })
})

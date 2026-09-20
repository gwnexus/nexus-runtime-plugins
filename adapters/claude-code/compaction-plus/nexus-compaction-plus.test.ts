import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  }
})

vi.mock("../../../core/compaction-plus/config.ts", () => ({
  getNexusConfig: vi.fn(),
}))

vi.mock("../../../core/compaction-plus/api.ts", () => ({
  appendCompactionEntry: vi.fn().mockResolvedValue(undefined),
}))

import { existsSync, readFileSync } from "node:fs"
import { getNexusConfig } from "../../../core/compaction-plus/config.ts"
import { appendCompactionEntry } from "../../../core/compaction-plus/api.ts"
import { parseClaudeTranscript, handlePreCompact, handlePostCompact } from "./nexus-compaction-plus.ts"

function transcriptLine(entry: unknown): string {
  return JSON.stringify(entry)
}

describe("compaction-plus Claude Code adapter", () => {
  let logs: Array<[string, string]>
  const logger = (level: string, message: string) => logs.push([level, message])

  beforeEach(() => {
    logs = []
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(getNexusConfig).mockReturnValue(null)
    vi.mocked(appendCompactionEntry).mockClear()
  })

  describe("parseClaudeTranscript", () => {
    it("returns an empty array when the transcript file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false)
      expect(parseClaudeTranscript("/tmp/does-not-exist.jsonl")).toEqual([])
    })

    it("pairs tool_use blocks with their tool_result by id", () => {
      const lines = [
        transcriptLine({
          message: {
            content: [
              { type: "tool_use", id: "call-1", name: "nexus_session_create", input: { project_id: "proj-1" } },
            ],
          },
        }),
        transcriptLine({
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: [{ type: "text", text: JSON.stringify({ id: "sess-1", title: "Test" }) }],
              },
            ],
          },
        }),
      ]
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"))

      const calls = parseClaudeTranscript("/tmp/transcript.jsonl")
      expect(calls).toHaveLength(1)
      expect(calls[0].tool).toBe("nexus_session_create")
      expect(calls[0].args).toEqual({ project_id: "proj-1" })
      expect(calls[0].result).toEqual({ id: "sess-1", title: "Test" })
    })

    it("includes unmatched tool_use blocks with result: null", () => {
      const lines = [
        transcriptLine({
          message: { content: [{ type: "tool_use", id: "call-2", name: "nexus_task_list", input: {} }] },
        }),
      ]
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"))

      const calls = parseClaudeTranscript("/tmp/transcript.jsonl")
      expect(calls).toHaveLength(1)
      expect(calls[0].result).toBeNull()
    })

    it("ignores malformed JSON lines without throwing", () => {
      vi.mocked(readFileSync).mockReturnValue("not json\n{broken")
      expect(() => parseClaudeTranscript("/tmp/transcript.jsonl")).not.toThrow()
    })
  })

  describe("handlePreCompact", () => {
    it("returns null when no transcript_path is provided", () => {
      const result = handlePreCompact({}, logger)
      expect(result).toBeNull()
    })

    it("returns null when no Nexus state is found in the transcript", () => {
      vi.mocked(readFileSync).mockReturnValue("")
      const result = handlePreCompact({ transcript_path: "/tmp/t.jsonl" }, logger)
      expect(result).toBeNull()
    })

    it("returns additionalContext when Nexus state is found", () => {
      const lines = [
        transcriptLine({
          message: {
            content: [
              { type: "tool_use", id: "c1", name: "nexus_session_create", input: { project_id: "p1" } },
              {
                type: "tool_result",
                tool_use_id: "c1",
                content: [{ type: "text", text: JSON.stringify({ id: "s1" }) }],
              },
            ],
          },
        }),
      ]
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"))

      const result = handlePreCompact({ transcript_path: "/tmp/t.jsonl" }, logger)
      expect(result).not.toBeNull()
      const payload = result as any
      expect(payload.hookSpecificOutput.hookEventName).toBe("PreCompact")
      expect(payload.hookSpecificOutput.additionalContext).toContain("s1")
      expect(payload.hookSpecificOutput.additionalContext).toContain("Nexus Platform Session Context")
    })
  })

  describe("handlePostCompact", () => {
    it("skips recording when no Nexus config is available", async () => {
      vi.mocked(getNexusConfig).mockReturnValue(null)
      await handlePostCompact({ cwd: "/tmp/proj", summary: "some summary" }, logger)
      expect(appendCompactionEntry).not.toHaveBeenCalled()
    })

    it("skips recording when no Nexus session ID is found", async () => {
      vi.mocked(getNexusConfig).mockReturnValue({ apiUrl: "https://nexus.example.com", token: "tok" })
      vi.mocked(readFileSync).mockReturnValue("")
      await handlePostCompact({ cwd: "/tmp/proj", transcript_path: "/tmp/t.jsonl", summary: "some summary" }, logger)
      expect(appendCompactionEntry).not.toHaveBeenCalled()
    })

    it("posts a compaction entry using the summary field supplied by the PostCompact hook", async () => {
      vi.mocked(getNexusConfig).mockReturnValue({ apiUrl: "https://nexus.example.com", token: "tok" })
      const lines = [
        transcriptLine({
          message: {
            content: [
              { type: "tool_use", id: "c1", name: "nexus_session_create", input: { project_id: "p1" } },
              {
                type: "tool_result",
                tool_use_id: "c1",
                content: [{ type: "text", text: JSON.stringify({ id: "s1" }) }],
              },
            ],
          },
        }),
      ]
      vi.mocked(readFileSync).mockReturnValue(lines.join("\n"))

      await handlePostCompact(
        { cwd: "/tmp/proj", transcript_path: "/tmp/t.jsonl", summary: "## Goal\n\nDo the thing." },
        logger,
      )

      expect(appendCompactionEntry).toHaveBeenCalledWith(
        { apiUrl: "https://nexus.example.com", token: "tok" },
        "s1",
        expect.stringContaining("Do the thing."),
        expect.any(Function),
      )
    })
  })
})

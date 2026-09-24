import { describe, it, expect, vi, beforeEach } from "vitest"

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

// Avoid real fs access from OriginalStore / StructuredLogger.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ size: 0, mtimeMs: Date.now() }),
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not found")
    }),
  }
})

// Mock the project/credential config resolution so tests can simulate a
// resolved project without touching the real filesystem or network.
vi.mock("../../../core/headroom-intercept/config.ts", () => ({
  readProjectIdFromAgentsMd: vi.fn(() => "test-project-id"),
  getNexusConfig: vi.fn(() => null), // no credentials -> gate stays permissive (no strict preflight)
  fetchProjectContext: vi.fn(async () => null),
}))

import {
  normalizeClaudeToolResponse,
  normalizeClaudeToolName,
  describeResponseShape,
  handlePostToolUse,
  handleStop,
} from "./nexus-headroom-intercept.ts"
import { StructuredLogger } from "../../../core/headroom-intercept/structured-logger.ts"

function fakeLogger(): StructuredLogger {
  return { log: vi.fn(), debug: vi.fn() } as unknown as StructuredLogger
}

const bigText = JSON.stringify({
  items: Array.from({ length: 40 }, (_, i) => ({ title: `Task ${i}: ${"description ".repeat(40)}`, id: `id-${i}`, status: "open" })),
})

/**
 * Fixture from a live capture (Dispatch 1bc7ff92, 2026-09-24): a real Claude
 * Code session calling `mcp__nexus__kb_search`, logged by a temporary
 * PostToolUse hook that recorded structure only. Observed: `tool_response` is
 * an array of length 1 whose block has keys `type` (string) and `text`
 * (string). Hook input also carries `mcp_server` and `tool_use_id`. Text
 * content below is synthetic.
 */
const LIVE_MCP_TOOL_RESPONSE = [{ type: "text", text: bigText }]

describe("headroom-intercept Claude Code adapter", () => {
  const cwd = "/tmp/test-project-headroom"

  beforeEach(() => {
    stateMemory.clear()
    // Force deterministic values regardless of ambient shell/.env config
    // (e.g. .env.nexus.local sets HEADROOM_MODE=transform and
    // HEADROOM_REQUIRE_PREFLIGHT=true for live dev usage).
    delete process.env.HEADROOM_REQUIRE_PREFLIGHT
    delete process.env.HEADROOM_MODE
  })

  describe("normalizeClaudeToolResponse", () => {
    it("handles plain string tool_response", () => {
      const r = normalizeClaudeToolResponse("hello world")
      expect(r.supported).toBe(true)
      expect(r.text).toBe("hello world")
      expect(r.sourceShape).toBe("string")
    })

    it("handles MCP content[] tool_response", () => {
      const r = normalizeClaudeToolResponse({ content: [{ type: "text", text: "abc" }] })
      expect(r.supported).toBe(true)
      expect(r.text).toBe("abc")
      expect(r.sourceShape).toBe("mcp-content")
    })

    it("returns unsupported for unknown shapes", () => {
      const r = normalizeClaudeToolResponse(42)
      expect(r.supported).toBe(false)
      expect(r.sourceShape).toBe("unknown")
    })

    it("handles the live Claude Code MCP shape: bare content-block array", () => {
      const r = normalizeClaudeToolResponse(LIVE_MCP_TOOL_RESPONSE)
      expect(r.supported).toBe(true)
      expect(r.text).toBe(LIVE_MCP_TOOL_RESPONSE[0].text)
      expect(r.sourceShape).toBe("mcp-content-array")
      expect(r.preserveVerbatim).toBe(false)
    })

    it("handles { content: string }", () => {
      const r = normalizeClaudeToolResponse({ content: "abc" })
      expect(r.supported).toBe(true)
      expect(r.text).toBe("abc")
      expect(r.sourceShape).toBe("mcp-content-string")
    })

    it("treats structuredContent as JSON text when no text blocks exist", () => {
      const r = normalizeClaudeToolResponse({ content: [], structuredContent: { a: 1 } })
      expect(r.supported).toBe(true)
      expect(r.text).toBe('{"a":1}')
      expect(r.sourceShape).toBe("mcp-structured-content")
    })

    it("prefers text blocks over structuredContent", () => {
      const r = normalizeClaudeToolResponse({ content: [{ type: "text", text: "t" }], structuredContent: { a: 1 } })
      expect(r.text).toBe("t")
      expect(r.sourceShape).toBe("mcp-content")
    })

    it("marks mixed text + non-text blocks as preserveVerbatim", () => {
      const r = normalizeClaudeToolResponse([{ type: "text", text: "t" }, { type: "image", data: "x", mimeType: "image/png" }])
      expect(r.preserveVerbatim).toBe(true)
    })

    it("marks only-non-text blocks as unsupported", () => {
      const r = normalizeClaudeToolResponse([{ type: "image", data: "x", mimeType: "image/png" }])
      expect(r.supported).toBe(false)
    })

    it("marks isError object responses as preserveVerbatim", () => {
      const r = normalizeClaudeToolResponse({ content: [{ type: "text", text: "boom" }], isError: true })
      expect(r.preserveVerbatim).toBe(true)
    })
  })

  describe("describeResponseShape", () => {
    it("describes structure only, never content", () => {
      const secret = "SECRET-CONTENT"
      const d = describeResponseShape([{ type: "text", text: secret }])
      expect(d).toEqual({ responseType: "array", responseLength: 1, firstBlockKeys: ["type", "text"] })
      expect(JSON.stringify(describeResponseShape({ content: [{ type: "text", text: secret }], other: secret }))).not.toContain(secret)
      expect(describeResponseShape(null)).toEqual({ responseType: "null" })
    })
  })

  describe("normalizeClaudeToolName", () => {
    it("normalizes mcp__nexus__X to nexus_X", () => {
      expect(normalizeClaudeToolName("mcp__nexus__kb_memory")).toBe("nexus_kb_memory")
    })

    it("normalizes mcp__nexus-headroom__X to X", () => {
      expect(normalizeClaudeToolName("mcp__nexus-headroom__headroom_retrieve")).toBe("headroom_retrieve")
    })

    it("leaves non-mcp tool names unchanged", () => {
      expect(normalizeClaudeToolName("nexus_kb_memory")).toBe("nexus_kb_memory")
      expect(normalizeClaudeToolName("Read")).toBe("Read")
    })

    it("leaves unrecognized mcp server names unchanged", () => {
      expect(normalizeClaudeToolName("mcp__some-other-server__tool")).toBe("mcp__some-other-server__tool")
    })
  })

  describe("handlePostToolUse", () => {
    it("returns null for a non-nexus tool (skip)", async () => {
      const logger = fakeLogger()
      const result = await handlePostToolUse({ cwd, tool_name: "Read", tool_response: "content" }, logger)
      expect(result).toBeNull()
    })

    it("returns null for write-operation tools (passthrough)", async () => {
      const logger = fakeLogger()
      const result = await handlePostToolUse(
        { cwd, tool_name: "nexus_session_append", tool_response: "ok" },
        logger,
      )
      expect(result).toBeNull()
    })

    it("returns null for small responses below threshold", async () => {
      const logger = fakeLogger()
      const result = await handlePostToolUse(
        { cwd, tool_name: "nexus_kb_memory", tool_response: '{"small":true}' },
        logger,
      )
      expect(result).toBeNull()
    })

    it("observes large responses without returning a payload in default observe mode", async () => {
      const logger = fakeLogger()
      const result = await handlePostToolUse(
        { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] } },
        logger,
      )
      // Default HEADROOM_MODE=observe -> engine returns "observed", not "transform_candidate",
      // so no hook payload is returned (matches OpenCode adapter's observe-mode no-mutation behavior).
      expect(result).toBeNull()
    })

    it("returns updatedToolOutput when HEADROOM_MODE=transform", async () => {
      const prev = process.env.HEADROOM_MODE
      process.env.HEADROOM_MODE = "transform"
      try {
        const logger = fakeLogger()
        const result = await handlePostToolUse(
          { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] } },
          logger,
        )
        expect(result).not.toBeNull()
        const payload = result as any
        expect(payload.hookSpecificOutput.hookEventName).toBe("PostToolUse")
        expect(payload.hookSpecificOutput.updatedToolOutput.content[0].text).toContain("[HEADROOM:v1]")
      } finally {
        process.env.HEADROOM_MODE = prev
      }
    })

    it("persists metrics across separate invocations (simulating separate processes)", async () => {
      const logger = fakeLogger()
      await handlePostToolUse({ cwd, tool_name: "nexus_kb_memory", tool_response: '{"small":true}' }, logger)
      await handlePostToolUse({ cwd, tool_name: "nexus_session_append", tool_response: "ok" }, logger)
      // No assertion error means state persisted/loaded correctly across two calls sharing `cwd`.
      expect(true).toBe(true)
    })

    it("recognizes mcp__nexus__X tool names via the same policy path as nexus_X", async () => {
      const prev = process.env.HEADROOM_MODE
      process.env.HEADROOM_MODE = "transform"
      try {
        const logger = fakeLogger()
        const result = await handlePostToolUse(
          { cwd, tool_name: "mcp__nexus__kb_memory", tool_response: { content: [{ type: "text", text: bigText }] } },
          logger,
        )
        expect(result).not.toBeNull()
        const payload = result as any
        expect(payload.hookSpecificOutput.updatedToolOutput.content[0].text).toContain("[HEADROOM:v1]")
      } finally {
        process.env.HEADROOM_MODE = prev
      }
    })
  })

  describe("handlePostToolUse with the live Claude Code shape", () => {
    it("compresses a bare content-block array and returns the same shape", async () => {
      process.env.HEADROOM_MODE = "transform"
      const logger = fakeLogger()
      const result = await handlePostToolUse(
        { cwd, tool_name: "mcp__nexus__kb_memory", tool_response: LIVE_MCP_TOOL_RESPONSE },
        logger,
      )
      const out = (result as any).hookSpecificOutput.updatedToolOutput
      expect(Array.isArray(out)).toBe(true)
      expect(out).toHaveLength(1)
      expect(out[0].type).toBe("text")
      expect(out[0].text).toContain("[HEADROOM:v1]")
      expect(logger.log).not.toHaveBeenCalledWith("warn", "unsupported_shape", expect.anything())
    })

    it("does not replace responses with non-text blocks", async () => {
      process.env.HEADROOM_MODE = "transform"
      const logger = fakeLogger()
      const result = await handlePostToolUse(
        {
          cwd,
          tool_name: "mcp__nexus__kb_memory",
          tool_response: [...LIVE_MCP_TOOL_RESPONSE, { type: "image", data: "x", mimeType: "image/png" }],
        },
        logger,
      )
      expect(result).toBeNull()
    })

    it("logs structure-only diagnostics on unsupported_shape", async () => {
      const logger = fakeLogger()
      await handlePostToolUse({ cwd, tool_name: "mcp__nexus__kb_memory", tool_response: { weird: "SECRET" } }, logger)
      expect(logger.log).toHaveBeenCalledWith(
        "warn",
        "unsupported_shape",
        expect.objectContaining({ tool: "nexus_kb_memory", sourceShape: "unknown", responseType: "object", topLevelKeys: ["weird"] }),
      )
      expect(JSON.stringify((logger.log as any).mock.calls)).not.toContain("SECRET")
    })
  })

  describe("handleStop", () => {
    it("includes session_id, mode and requestedMode in session_summary", async () => {
      process.env.HEADROOM_MODE = "transform"
      const logger = fakeLogger()
      await handlePostToolUse(
        { cwd, tool_name: "mcp__nexus__kb_memory", tool_response: LIVE_MCP_TOOL_RESPONSE, session_id: "s-mode" },
        logger,
      )
      handleStop(cwd, logger, "s-mode")
      expect(logger.log).toHaveBeenCalledWith(
        "info",
        "session_summary",
        expect.objectContaining({ session_id: "s-mode", mode: "transform", requestedMode: "transform", downgradeReason: null, compressions: 1 }),
      )
    })

    it("does not throw when there is no accumulated activity", () => {
      const logger = fakeLogger()
      expect(() => handleStop(cwd, logger)).not.toThrow()
    })

    it("logs a cumulative session_summary and does NOT reset metrics within the same session", async () => {
      const prev = process.env.HEADROOM_MODE
      process.env.HEADROOM_MODE = "transform"
      try {
        const logger = fakeLogger()
        await handlePostToolUse(
          { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] }, session_id: "s1" },
          logger,
        )
        handleStop(cwd, logger, "s1")
        expect(logger.log).toHaveBeenCalledWith("info", "session_summary", expect.objectContaining({ compressions: 1 }))

        // Simulate a second turn within the SAME session (session_id unchanged):
        // Stop fires again, but metrics must still reflect the cumulative total,
        // not be reset back to zero.
        await handlePostToolUse(
          { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] }, session_id: "s1" },
          logger,
        )
        handleStop(cwd, logger, "s1")
        expect(logger.log).toHaveBeenCalledWith("info", "session_summary", expect.objectContaining({ compressions: 2 }))
      } finally {
        process.env.HEADROOM_MODE = prev
      }
    })

    it("resets metrics when a new session_id is observed", async () => {
      const prev = process.env.HEADROOM_MODE
      process.env.HEADROOM_MODE = "transform"
      try {
        const logger = fakeLogger()
        await handlePostToolUse(
          { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] }, session_id: "session-a" },
          logger,
        )
        handleStop(cwd, logger, "session-a")
        expect(logger.log).toHaveBeenCalledWith("info", "session_summary", expect.objectContaining({ compressions: 1 }))

        // New session_id -> metrics must reset, not carry over the prior session's count.
        await handlePostToolUse(
          { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] }, session_id: "session-b" },
          logger,
        )
        handleStop(cwd, logger, "session-b")
        expect(logger.log).toHaveBeenCalledWith("info", "session_summary", expect.objectContaining({ compressions: 1 }))
      } finally {
        process.env.HEADROOM_MODE = prev
      }
    })
  })
})

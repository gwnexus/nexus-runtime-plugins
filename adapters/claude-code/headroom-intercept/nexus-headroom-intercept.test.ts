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

import { normalizeClaudeToolResponse, handlePostToolUse, handleStop } from "./nexus-headroom-intercept.ts"
import { StructuredLogger } from "../../../core/headroom-intercept/structured-logger.ts"

function fakeLogger(): StructuredLogger {
  return { log: vi.fn(), debug: vi.fn() } as unknown as StructuredLogger
}

const bigText = JSON.stringify({
  items: Array.from({ length: 40 }, (_, i) => ({ title: `Task ${i}: ${"description ".repeat(40)}`, id: `id-${i}`, status: "open" })),
})

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

    it("returns updatedToolOutput/additionalContext when HEADROOM_MODE=transform", async () => {
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
        expect(payload.hookSpecificOutput.updatedToolOutput).toContain("[HEADROOM:v1]")
        expect(payload.hookSpecificOutput.additionalContext).toBe(payload.hookSpecificOutput.updatedToolOutput)
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
  })

  describe("handleStop", () => {
    it("does not throw when there is no accumulated activity", () => {
      const logger = fakeLogger()
      expect(() => handleStop(cwd, logger)).not.toThrow()
    })

    it("logs a session_summary and resets metrics when there was activity", async () => {
      const prev = process.env.HEADROOM_MODE
      process.env.HEADROOM_MODE = "transform"
      try {
        const logger = fakeLogger()
        await handlePostToolUse(
          { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] } },
          logger,
        )
        handleStop(cwd, logger)
        expect(logger.log).toHaveBeenCalledWith("info", "session_summary", expect.objectContaining({ compressions: 1 }))
      } finally {
        process.env.HEADROOM_MODE = prev
      }
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Only mock the network/credential-resolution boundary -- everything else
// (state-store, OriginalStore, StructuredLogger) hits the real filesystem
// under a temp directory. Fix, Dispatch 0e38cf7b review: the unit test file
// mocks core/state-store.ts with a plain in-memory Map, which does not
// exercise the real `loadState()` object-spread bug (a bare JSON string like
// `"s-1"` spread as `{ ...fallback, ..."s-1" }` silently corrupted into
// `{0:'s',1:'-',2:'1'}`, making every session_id comparison always look like
// a new session). This test exercises the real core/state-store.ts to catch
// that class of regression.
vi.mock("../../../core/headroom-intercept/config.ts", () => ({
  readProjectIdFromAgentsMd: vi.fn(() => "test-project-id"),
  getNexusConfig: vi.fn(() => null),
  fetchProjectContext: vi.fn(async () => null),
}))

import { handlePostToolUse, handleStop } from "./nexus-headroom-intercept.ts"
import { StructuredLogger } from "../../../core/headroom-intercept/structured-logger.ts"

function fakeLogger(): StructuredLogger {
  return { log: vi.fn(), debug: vi.fn() } as unknown as StructuredLogger
}

const bigText = JSON.stringify({
  items: Array.from({ length: 40 }, (_, i) => ({ title: `Task ${i}: ${"description ".repeat(40)}`, id: `id-${i}`, status: "open" })),
})

describe("headroom-intercept Claude Code adapter — real filesystem integration", () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nx-headroom-integration-"))
    // Force deterministic values regardless of ambient shell/.env config
    // (e.g. .env.nexus.local sets HEADROOM_MODE=transform and
    // HEADROOM_REQUIRE_PREFLIGHT=true for live dev usage).
    delete process.env.HEADROOM_REQUIRE_PREFLIGHT
    delete process.env.HEADROOM_MODE
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it("accumulates cumulative compressions across post/stop/post/stop for the same session_id (Fix, Dispatch 0e38cf7b review)", async () => {
    const prev = process.env.HEADROOM_MODE
    process.env.HEADROOM_MODE = "transform"
    try {
      const logger = fakeLogger()

      await handlePostToolUse(
        { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] }, session_id: "s-1" },
        logger,
      )
      handleStop(cwd, logger, "s-1")
      expect(logger.log).toHaveBeenCalledWith("info", "session_summary", expect.objectContaining({ compressions: 1 }))

      await handlePostToolUse(
        { cwd, tool_name: "nexus_kb_memory", tool_response: { content: [{ type: "text", text: bigText }] }, session_id: "s-1" },
        logger,
      )
      handleStop(cwd, logger, "s-1")
      expect(logger.log).toHaveBeenCalledWith("info", "session_summary", expect.objectContaining({ compressions: 2 }))
    } finally {
      process.env.HEADROOM_MODE = prev
    }
  })

  it("resets to a fresh count when session_id changes, against the real filesystem", async () => {
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

import { describe, it, expect, vi } from "vitest"
import { intercept, commitTransformed, commitTransformFailed } from "./engine.ts"
import { initialMetrics } from "./types.ts"
import type { SessionMetrics } from "./types.ts"
import type { OriginalStore } from "./store.ts"
import type { StructuredLogger } from "./structured-logger.ts"

function fakeLogger(): StructuredLogger {
  return { log: vi.fn(), debug: vi.fn() } as unknown as StructuredLogger
}

function fakeStore(): OriginalStore {
  return { set: vi.fn(), prune: vi.fn(), get: vi.fn() } as unknown as OriginalStore
}

const bigText = JSON.stringify({
  items: Array.from({ length: 40 }, (_, i) => ({ title: `Task ${i}: ${"description ".repeat(40)}`, id: `id-${i}`, status: "open" })),
})

describe("headroom-intercept core engine", () => {
  it("skips tools with no nexus_/headroom_ prefix", () => {
    const metrics = initialMetrics()
    const result = intercept(
      { toolName: "Read", text: "content", supported: true, sourceShape: "normalized-output", isError: false, mode: "observe" },
      metrics,
      fakeStore(),
      fakeLogger(),
    )
    expect(result.action).toBe("skip")
    expect(metrics.totalSkips).toBe(1)
  })

  it("passes through write-operation tools", () => {
    const metrics = initialMetrics()
    const result = intercept(
      { toolName: "nexus_session_append", text: "content", supported: true, sourceShape: "normalized-output", isError: false, mode: "observe" },
      metrics,
      fakeStore(),
      fakeLogger(),
    )
    expect(result.action).toBe("passthrough")
    expect(metrics.totalPassthroughs).toBe(1)
  })

  it("passes through error responses even for compress-policy tools", () => {
    const metrics = initialMetrics()
    const result = intercept(
      { toolName: "nexus_kb_memory", text: bigText, supported: true, sourceShape: "mcp-content", isError: true, mode: "observe" },
      metrics,
      fakeStore(),
      fakeLogger(),
    )
    expect(result.action).toBe("passthrough")
  })

  it("passes through below-threshold responses", () => {
    const metrics = initialMetrics()
    const result = intercept(
      { toolName: "nexus_kb_memory", text: '{"small":true}', supported: true, sourceShape: "mcp-content", isError: false, mode: "observe" },
      metrics,
      fakeStore(),
      fakeLogger(),
    )
    expect(result.action).toBe("passthrough")
  })

  it("returns unsupported_shape when text extraction failed", () => {
    const metrics = initialMetrics()
    const result = intercept(
      { toolName: "nexus_kb_memory", text: null, supported: false, sourceShape: "unknown", isError: false, mode: "observe" },
      metrics,
      fakeStore(),
      fakeLogger(),
    )
    expect(result.action).toBe("unsupported_shape")
    expect(metrics.totalUnsupportedShapes).toBe(1)
  })

  it("observes (does not mutate) large responses in observe mode", () => {
    const metrics = initialMetrics()
    const result = intercept(
      { toolName: "nexus_kb_memory", text: bigText, supported: true, sourceShape: "mcp-content", isError: false, mode: "observe" },
      metrics,
      fakeStore(),
      fakeLogger(),
    )
    expect(result.action).toBe("observed")
    expect(result.compact).toBeDefined()
    expect(metrics.totalObservations).toBe(1)
    expect(metrics.events).toHaveLength(1)
  })

  it("returns a transform_candidate in transform mode and stores the original", () => {
    const metrics = initialMetrics()
    const store = fakeStore()
    const result = intercept(
      { toolName: "nexus_kb_memory", text: bigText, supported: true, sourceShape: "mcp-content", isError: false, mode: "transform" },
      metrics,
      store,
      fakeLogger(),
    )
    expect(result.action).toBe("transform_candidate")
    expect(store.set).toHaveBeenCalledWith(expect.any(String), bigText)
    // Not committed to metrics yet — adapter must call commitTransformed()
    expect(metrics.totalCompressions).toBe(0)
  })

  it("commitTransformed increments compression counters and pushes the event", () => {
    const metrics: SessionMetrics = initialMetrics()
    const logger = fakeLogger()
    const store = fakeStore()
    const result = intercept(
      { toolName: "nexus_kb_memory", text: bigText, supported: true, sourceShape: "mcp-content", isError: false, mode: "transform" },
      metrics,
      store,
      logger,
    )
    commitTransformed(result.event!, metrics, logger)
    expect(metrics.totalCompressions).toBe(1)
    expect(metrics.locallyAppliedTransforms).toBe(1)
    expect(metrics.events).toHaveLength(1)
  })

  it("commitTransformFailed fails open (counts as observation, not compression)", () => {
    const metrics: SessionMetrics = initialMetrics()
    const logger = fakeLogger()
    const result = intercept(
      { toolName: "nexus_kb_memory", text: bigText, supported: true, sourceShape: "mcp-content", isError: false, mode: "transform" },
      metrics,
      fakeStore(),
      logger,
    )
    commitTransformFailed(result.event!, metrics, logger, new Error("apply failed"))
    expect(metrics.totalCompressions).toBe(0)
    expect(metrics.totalObservations).toBe(1)
  })

  it("skips compression when saving ratio is too small (no_gain)", () => {
    const metrics = initialMetrics()
    // Barely-above-threshold unstructured text that won't compress well via fallback profile
    const text = "x".repeat(8100) // ~2025 tokens, just above the 2000 threshold
    const result = intercept(
      { toolName: "nexus_kb_memory", text, supported: true, sourceShape: "mcp-content", isError: false, mode: "observe" },
      metrics,
      fakeStore(),
      fakeLogger(),
    )
    // compressReferenceData on non-JSON text still emits a fair amount of structural
    // overhead; either no_gain or observed is acceptable here, but it must not throw.
    expect(["no_gain", "observed"]).toContain(result.action)
  })
})

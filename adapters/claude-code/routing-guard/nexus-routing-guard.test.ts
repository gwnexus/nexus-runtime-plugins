import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  }
})

import { existsSync, readFileSync } from "node:fs"
import { handleSessionStart } from "./nexus-routing-guard.ts"

describe("routing-guard Claude Code adapter", () => {
  const logs: Array<[string, string]> = []
  const logger = (level: string, message: string) => logs.push([level, message])

  const prevEnabled = process.env.NEXUS_ROUTING_GUARD_ENABLED
  const prevCatalogPath = process.env.NEXUS_ROUTING_GUARD_CATALOG_PATH
  const prevAgentsPath = process.env.NEXUS_ROUTING_GUARD_AGENTS_PATH

  beforeEach(() => {
    logs.length = 0
    delete process.env.NEXUS_ROUTING_GUARD_ENABLED
    delete process.env.NEXUS_ROUTING_GUARD_CATALOG_PATH
    delete process.env.NEXUS_ROUTING_GUARD_AGENTS_PATH
    vi.mocked(existsSync).mockReturnValue(false)
  })

  afterAll(() => {
    if (prevEnabled !== undefined) process.env.NEXUS_ROUTING_GUARD_ENABLED = prevEnabled
    if (prevCatalogPath !== undefined) process.env.NEXUS_ROUTING_GUARD_CATALOG_PATH = prevCatalogPath
    if (prevAgentsPath !== undefined) process.env.NEXUS_ROUTING_GUARD_AGENTS_PATH = prevAgentsPath
  })

  it("returns null when disabled via env var", () => {
    process.env.NEXUS_ROUTING_GUARD_ENABLED = "false"
    const result = handleSessionStart({}, logger)
    expect(result).toBeNull()
  })

  it("returns null and logs a warning when the catalog/agents files are missing", () => {
    const result = handleSessionStart({}, logger)
    expect(result).toBeNull()
    expect(logs.some(([level, msg]) => level === "warn" && msg.includes("Skipping check"))).toBe(true)
  })

  it("returns null when the config is clean", () => {
    process.env.NEXUS_ROUTING_GUARD_CATALOG_PATH = "/tmp/catalog.json"
    process.env.NEXUS_ROUTING_GUARD_AGENTS_PATH = "/tmp/agents.json"
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (String(path).includes("catalog")) {
        return JSON.stringify({ providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }] })
      }
      return JSON.stringify([{ name: "nexus-plan", model: { providerID: "github-copilot", modelID: "claude-sonnet-5" } }])
    })

    const result = handleSessionStart({}, logger)
    expect(result).toBeNull()
  })

  it("returns an additionalContext banner when divergence is detected", () => {
    process.env.NEXUS_ROUTING_GUARD_CATALOG_PATH = "/tmp/catalog.json"
    process.env.NEXUS_ROUTING_GUARD_AGENTS_PATH = "/tmp/agents.json"
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (String(path).includes("catalog")) {
        return JSON.stringify({ providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }] })
      }
      return JSON.stringify([{ name: "nexus-plan", model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" } }])
    })

    const result = handleSessionStart({}, logger)
    expect(result).not.toBeNull()
    const payload = result as any
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(payload.hookSpecificOutput.additionalContext).toContain("[nexus-routing-guard]")
    expect(payload.hookSpecificOutput.additionalContext).toContain("nexus-plan")
  })

  it("degrades silently (returns null) when the catalog/agents JSON is malformed", () => {
    process.env.NEXUS_ROUTING_GUARD_CATALOG_PATH = "/tmp/catalog.json"
    process.env.NEXUS_ROUTING_GUARD_AGENTS_PATH = "/tmp/agents.json"
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue("not valid json")

    expect(() => handleSessionStart({}, logger)).not.toThrow()
    expect(handleSessionStart({}, logger)).toBeNull()
  })

  describe("nexus-cli generated file shape (routing-catalog.json / agent-routing.json)", () => {
    it("auto-detects and transforms the real nexus-cli shape, using default paths under .nexus/generated/ when no env vars are set", () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockImplementation((path: any) => {
        expect(String(path)).toContain(".nexus/generated/")
        if (String(path).includes("routing-catalog")) {
          return JSON.stringify({
            model_routes: [{ route_alias: "nexus-plan", provider: "github-copilot", model: "claude-sonnet-5" }],
          })
        }
        return JSON.stringify({ actors: [{ slug: "nexus-plan", model_profile_id: "nexus-plan" }] })
      })

      const result = handleSessionStart({ cwd: "/tmp/proj" }, logger)
      expect(result).toBeNull() // clean — no divergence
    })

    it("skips agents whose model_profile_id has no matching route (no divergence possible)", () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockImplementation((path: any) => {
        if (String(path).includes("routing-catalog")) {
          return JSON.stringify({
            model_routes: [{ route_alias: "nexus-plan", provider: "github-copilot", model: "claude-sonnet-5" }],
          })
        }
        // model_profile_id points to a route_alias that isn't in the catalog above
        return JSON.stringify({ actors: [{ slug: "nexus-orphan", model_profile_id: "nonexistent-alias" }] })
      })

      // No matching route -> agent has no explicit model -> never checked -> clean.
      // Real divergence detection through this transform is covered end-to-end
      // in core/routing-guard/nexus-cli-catalog.test.ts.
      const result = handleSessionStart({ cwd: "/tmp/proj" }, logger)
      expect(result).toBeNull()
    })
  })
})

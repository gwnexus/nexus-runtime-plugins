import { describe, it, expect } from "vitest"
import { buildProviderCatalogFromRoutes, buildAgentInfoFromActors } from "./nexus-cli-catalog.ts"
import { detectRoutingWarnings } from "./detect.ts"

describe("routing-guard nexus-cli catalog transform", () => {
  const catalogFile = {
    model_routes: [
      { route_alias: "nexus-plan", provider: "github-copilot", model: "claude-sonnet-5", lifecycle_status: "active" },
      { route_alias: "nexus-act", provider: "opencode", model: "big-pickle", lifecycle_status: "active" },
    ],
  }

  it("builds a ProviderCatalog grouped by provider", () => {
    const catalog = buildProviderCatalogFromRoutes(catalogFile)
    expect(catalog.providers).toHaveLength(2)
    const copilot = catalog.providers.find((p) => p.id === "github-copilot")
    expect(copilot?.models).toHaveProperty("claude-sonnet-5")
  })

  it("builds AgentInfo[] by resolving model_profile_id against route_alias", () => {
    const agentFile = {
      actors: [
        { slug: "nexus-plan", model_profile_id: "nexus-plan", is_primary: true },
        { slug: "nexus-build" }, // no model_profile_id -> no explicit model
      ],
    }
    const agents = buildAgentInfoFromActors(agentFile, catalogFile)
    expect(agents).toHaveLength(2)
    expect(agents[0].model).toEqual({ providerID: "github-copilot", modelID: "claude-sonnet-5" })
    expect(agents[1].model).toBeUndefined()
  })

  it("leaves model undefined when model_profile_id has no matching route", () => {
    const agentFile = { actors: [{ slug: "nexus-orphan", model_profile_id: "unknown-alias" }] }
    const agents = buildAgentInfoFromActors(agentFile, catalogFile)
    expect(agents[0].model).toBeUndefined()
  })

  it("end-to-end: transformed real-shape files feed detectRoutingWarnings correctly", () => {
    const divergentAgentFile = {
      actors: [{ slug: "nexus-plan", model_profile_id: "nexus-plan" }],
    }
    const divergentCatalog = {
      model_routes: [{ route_alias: "nexus-plan", provider: "github-copilot", model: "claude-sonnet-4-6" }],
    }
    const catalog = buildProviderCatalogFromRoutes(catalogFile) // does NOT contain claude-sonnet-4-6
    const agents = buildAgentInfoFromActors(divergentAgentFile, divergentCatalog)

    const warnings = detectRoutingWarnings(catalog, agents)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe("unknown_model")
  })
})

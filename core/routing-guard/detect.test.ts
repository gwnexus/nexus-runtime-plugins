import { describe, it, expect } from "vitest"
import { detectRoutingWarnings } from "./detect.ts"
import { formatBanner, formatSystemPromptContext } from "./format.ts"

describe("routing-guard core detect", () => {
  it("returns no warnings for a healthy config", () => {
    const warnings = detectRoutingWarnings(
      { providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }] },
      [{ name: "nexus-plan", model: { providerID: "github-copilot", modelID: "claude-sonnet-5" } }],
    )
    expect(warnings).toHaveLength(0)
  })

  it("flags unknown_provider", () => {
    const warnings = detectRoutingWarnings(
      { providers: [{ id: "openai", models: { "gpt-5": {} } }] },
      [{ name: "nexus-plan", model: { providerID: "github-copilot", modelID: "claude-sonnet-5" } }],
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe("unknown_provider")
  })

  it("flags unknown_model", () => {
    const warnings = detectRoutingWarnings(
      { providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }] },
      [{ name: "nexus-plan", model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" } }],
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe("unknown_model")
  })

  it("does not check agents without an explicit model", () => {
    const warnings = detectRoutingWarnings({ providers: [{ id: "openai", models: {} }] }, [{ name: "build" }])
    expect(warnings).toHaveLength(0)
  })

  it("reports multiple divergent agents independently", () => {
    const warnings = detectRoutingWarnings({ providers: [{ id: "opencode", models: { "big-pickle": {} } }] }, [
      { name: "nexus-plan", model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" } },
      { name: "nexus-review", model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" } },
      { name: "nexus-act", model: { providerID: "opencode", modelID: "big-pickle" } },
    ])
    expect(warnings).toHaveLength(2)
    expect(warnings.map((w) => w.agent)).toEqual(["nexus-plan", "nexus-review"])
  })
})

describe("routing-guard core format", () => {
  const warnings = [
    {
      code: "unknown_model" as const,
      agent: "nexus-plan",
      provider: "github-copilot",
      model: "claude-sonnet-4-6",
      message: 'Agent "nexus-plan" is routed to "github-copilot/claude-sonnet-4-6", but provider "github-copilot" does not serve a model with that id.',
    },
  ]

  it("formatBanner wraps warnings in a system-reminder block", () => {
    const banner = formatBanner(warnings)
    expect(banner).toContain("<system-reminder>")
    expect(banner).toContain("[nexus-routing-guard]")
    expect(banner).toContain("unknown_model")
    expect(banner).toContain("nexus-plan")
  })

  it("formatSystemPromptContext lists warnings for the system prompt", () => {
    const context = formatSystemPromptContext(warnings)
    expect(context).toContain("nexus-plan")
    expect(context).toContain("unknown_model")
  })
})

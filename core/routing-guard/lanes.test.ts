import { describe, it, expect } from "vitest"
import { detectLaneWarnings, isAllowedSessionModel, parseSubagentFrontmatter, summarizeLanes } from "./lanes.ts"
import type { ActorEntry } from "./nexus-cli-catalog.ts"

/** Shape of a resolved runtime_spec: two session-lane actors and two local (gateway-lane) actors. */
const actors: ActorEntry[] = [
  { slug: "architect", profile_slug: "anthropic-premium-reasoning", lane: "session", session_model: "opus", status: "resolved" },
  { slug: "reviewer", profile_slug: "balanced-review", lane: "session", session_model: "inherit", status: "resolved" },
  { slug: "spark-coder", profile_slug: "local-coder-main", lane: "gateway", status: "resolved" },
  { slug: "spark-review", profile_slug: "local-review", lane: "gateway", status: "resolved" },
]

describe("isAllowedSessionModel", () => {
  it("accepts the session allowlist and explicit claude-* ids", () => {
    for (const m of ["inherit", "sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4.8", " opus "]) {
      expect(isAllowedSessionModel(m)).toBe(true)
    }
  })

  it("rejects gateway models, provider-qualified ids and other vendors", () => {
    for (const m of ["nexus-coder-main", "local-coder-main", "anthropic/claude-sonnet-4-6", "gpt-5.2-codex", "claude-", "Opus", ""]) {
      expect(isAllowedSessionModel(m)).toBe(false)
    }
  })
})

describe("parseSubagentFrontmatter", () => {
  it("reads name and model from a Claude Code subagent file", () => {
    const md = '---\nname: reviewer\ndescription: "Reviews diffs"\nmodel: sonnet\ntools: Read, Grep\n---\n\nBody'
    expect(parseSubagentFrontmatter(md)).toEqual({ name: "reviewer", model: "sonnet" })
    expect(parseSubagentFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\n")).toEqual({ name: "a" })
  })

  it("ignores files the runtime would not load as subagents", () => {
    // hub actor markdown: Nexus frontmatter without name/description
    expect(parseSubagentFrontmatter("---\nid: 1\nslug: spark-coder\nrouting: x\n---\nBody")).toBeNull()
    expect(parseSubagentFrontmatter("---\nname: a\n---\n")).toBeNull()
    expect(parseSubagentFrontmatter("no frontmatter")).toBeNull()
  })
})

describe("detectLaneWarnings", () => {
  it("reports no mismatch for session-lane actors with allowed models", () => {
    const subagents = [
      { name: "architect", model: "opus" },
      { name: "reviewer", model: "inherit" },
    ]
    expect(detectLaneWarnings(actors, subagents)).toEqual([])
  })

  it("flags a session-lane subagent whose model is outside the allowlist", () => {
    const w = detectLaneWarnings(actors, [{ name: "reviewer", model: "nexus-coder-main" }])
    expect(w.map((x) => [x.code, x.agent, x.model])).toEqual([["session_model_not_allowed", "reviewer", "nexus-coder-main"]])
  })

  it("falls back to the hub's session_model when no subagent file exists", () => {
    const w = detectLaneWarnings([{ slug: "a", lane: "session", session_model: "gpt-5.2-codex" }], [])
    expect(w[0]?.code).toBe("session_model_not_allowed")
  })

  it("flags a gateway-lane actor defined as a session subagent", () => {
    const w = detectLaneWarnings(actors, [{ name: "spark-coder", model: "inherit" }])
    expect(w.map((x) => [x.code, x.agent])).toEqual([["gateway_actor_in_session", "spark-coder"]])
  })

  it("flags unresolved actors and skips actors without a lane (older hubs)", () => {
    const w = detectLaneWarnings(
      [
        { slug: "x", lane: "session", session_model: "inherit", status: "unresolved_alias", route_alias: "gone" },
        { slug: "legacy", model_profile_id: "3f1c0f9e-0000-4000-8000-000000000000" },
      ],
      [{ name: "legacy", model: "gpt-4o" }],
    )
    expect(w.map((x) => [x.code, x.agent, x.model])).toEqual([["unresolved_actor_model", "x", "gone"]])
  })
})

describe("summarizeLanes", () => {
  it("lists actors per lane", () => {
    expect(summarizeLanes(actors)).toBe("session=[architect, reviewer] gateway=[spark-coder, spark-review]")
    expect(summarizeLanes([{ slug: "legacy" }])).toBeNull()
  })
})

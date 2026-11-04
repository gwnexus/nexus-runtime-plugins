import { describe, it, expect } from "vitest"
import {
  detectLaneWarnings,
  isAllowedSessionModel,
  isThinDelegate,
  parseSubagentFrontmatter,
  summarizeLanes,
} from "./lanes.ts"
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
    expect(parseSubagentFrontmatter(md)).toEqual({ name: "reviewer", model: "sonnet", tools: "Read, Grep" })
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

/** Showcase beta runtime_spec as shipped by the hub on staging (2026-11-04). */
const betaActors: ActorEntry[] = [
  { slug: "claude-default", lane: "session", lane_source: "explicit", session_model: "claude-opus-5-5", model_status: "unbound" },
  { slug: "spark-coder", lane: "gateway", lane_source: "profile", profile_slug: "nexus-coder-long", session_model: "inherit", model_status: "resolved" },
  { slug: "spark-review", lane: "gateway", lane_source: "profile", profile_slug: "nexus-review-local", session_model: "inherit", model_status: "resolved" },
]
const delegate = (slug: string) =>
  `---\nname: ${slug}\ndescription: Runs ${slug} in a gateway-backed process\nmodel: haiku\ntools: Bash\n---\n\nRun \`nexus actors run ${slug} -p "<task>"\` and return its output.\n`

describe("hub runtime_spec (model_status, thin delegates)", () => {
  const claudeDefault = parseSubagentFrontmatter("---\nname: claude-default\ndescription: d\nmodel: claude-opus-5-5\n---\n")!

  it("beta app with thin delegates: gateway lane listed, no warnings", () => {
    const subagents = [claudeDefault, parseSubagentFrontmatter(delegate("spark-coder"))!, parseSubagentFrontmatter(delegate("spark-review"))!]
    expect(detectLaneWarnings(betaActors, subagents)).toEqual([])
    expect(summarizeLanes(betaActors)).toBe("session=[claude-default] gateway=[spark-coder, spark-review]")
  })

  it("beta app restricted (no delegates written): no warnings", () => {
    expect(detectLaneWarnings(betaActors, [claudeDefault])).toEqual([])
  })

  it("parses tools and the delegated actor from the body", () => {
    expect(parseSubagentFrontmatter(delegate("spark-coder"))).toEqual({
      name: "spark-coder",
      model: "haiku",
      tools: "Bash",
      delegatesTo: "spark-coder",
    })
  })

  it("recognises thin delegates by marker or by haiku + Bash only", () => {
    expect(isThinDelegate({ name: "a", model: "haiku", tools: "Bash" }, "a")).toBe(true)
    expect(isThinDelegate({ name: "a", model: "haiku", tools: "[\"Bash\"]" }, "a")).toBe(true)
    expect(isThinDelegate({ name: "a", model: "sonnet", delegatesTo: "a" }, "a")).toBe(true)
    expect(isThinDelegate({ name: "a", model: "haiku", tools: "Bash, Read" }, "a")).toBe(false)
    expect(isThinDelegate({ name: "a", model: "sonnet", tools: "Bash" }, "a")).toBe(false)
    expect(isThinDelegate({ name: "a", model: "haiku" }, "a")).toBe(false)
    expect(isThinDelegate({ name: "a", model: "haiku", tools: "Bash", delegatesTo: "b" }, "a")).toBe(true)
  })

  it("still flags a gateway-lane subagent that is not a thin delegate", () => {
    const w = detectLaneWarnings(betaActors, [{ name: "spark-coder", model: "haiku", tools: "Bash, Read, Edit" }])
    expect(w.map((x) => [x.code, x.agent])).toEqual([["gateway_actor_in_session", "spark-coder"]])
  })

  it("unbound warns only on the gateway lane; unresolved_alias on every lane", () => {
    const w = detectLaneWarnings(
      [
        { slug: "s-unbound", lane: "session", session_model: "sonnet", model_status: "unbound" },
        { slug: "g-unbound", lane: "gateway", model_status: "unbound" },
        { slug: "s-alias", lane: "session", session_model: "inherit", model_status: "unresolved_alias", route_alias: "gone" },
        { slug: "g-ok", lane: "gateway", profile_slug: "p", model_status: "resolved", status: "unresolved_alias" },
      ],
      [],
    )
    expect(w.map((x) => [x.code, x.agent])).toEqual([
      ["unresolved_actor_model", "g-unbound"],
      ["unresolved_actor_model", "s-alias"],
    ])
  })
})

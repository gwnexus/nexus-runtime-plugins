import type { ActorEntry } from "./nexus-cli-catalog.ts"
import type { RoutingWarning } from "./types.ts"

/**
 * Lane checks for Claude Code (core module), pure functions.
 *
 * Newer hubs resolve every actor's model once and ship the result in
 * `runtime_spec.actors` (mirrored to `.nexus/generated/agent-routing.json`):
 * `profile_slug`, `lane` (`session` | `gateway`), `session_model` and a
 * resolution `status`. A `session`-lane actor runs inside the operator's
 * Claude session and may only name a model from the session allowlist. A
 * `gateway`-lane actor needs a gateway-backed process; one Claude session has
 * a single process-wide base URL, so such an actor must never be loaded as a
 * session subagent. All findings are warnings; nothing is blocked.
 *
 * Actors without a `lane` (older hubs) are not checked here.
 */

export type ActorLane = "session" | "gateway"

/** Session models a Claude Code subagent may name. */
const SESSION_MODEL_RE = /^(inherit|sonnet|opus|haiku|claude-[a-z0-9][a-z0-9.\-]*)$/

export function isAllowedSessionModel(model: string): boolean {
  return SESSION_MODEL_RE.test(model.trim())
}

/** A Claude Code subagent definition (`.claude/agents/*.md`) as loaded by the runtime. */
export interface ClaudeSubagent {
  name: string
  model?: string
}

/**
 * Parse the YAML frontmatter of a subagent file. Returns null unless the file
 * declares both `name` and `description`, the fields Claude Code needs to
 * load it as a subagent; hub actor markdown without them is never loaded.
 */
export function parseSubagentFrontmatter(markdown: string): ClaudeSubagent | null {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const fields = new Map<string, string>()
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) fields.set(kv[1], kv[2].trim().replace(/^(["'])(.*)\1$/, "$2"))
  }
  const name = fields.get("name")
  if (!name || !fields.get("description")) return null
  const model = fields.get("model")
  return model ? { name, model } : { name }
}

export function actorLane(actor: ActorEntry): ActorLane | null {
  return actor.lane === "session" || actor.lane === "gateway" ? actor.lane : null
}

export function detectLaneWarnings(actors: ActorEntry[], subagents: ClaudeSubagent[]): RoutingWarning[] {
  const subagentByName = new Map(subagents.map((s) => [s.name, s]))
  const warnings: RoutingWarning[] = []

  for (const actor of actors) {
    const lane = actorLane(actor)
    if (!lane) continue
    const subagent = subagentByName.get(actor.slug)

    if (actor.status && actor.status !== "resolved") {
      warnings.push({
        code: "unresolved_actor_model",
        agent: actor.slug,
        provider: lane,
        model: actor.profile_slug ?? actor.route_alias ?? "",
        message: `Agent "${actor.slug}" has no resolved model on the Nexus side (status "${actor.status}"); it runs on the session default.`,
      })
    }

    if (lane === "gateway") {
      if (subagent) {
        warnings.push({
          code: "gateway_actor_in_session",
          agent: actor.slug,
          provider: lane,
          model: subagent.model ?? "",
          message: `Agent "${actor.slug}" belongs to the gateway lane but is defined as a Claude Code subagent (.claude/agents); it would run inside the subscription session instead of a gateway-backed process.`,
        })
      }
      continue
    }

    const model = subagent?.model ?? actor.session_model
    if (model && !isAllowedSessionModel(model)) {
      warnings.push({
        code: "session_model_not_allowed",
        agent: actor.slug,
        provider: lane,
        model,
        message: `Agent "${actor.slug}" runs in the Claude session but names model "${model}"; only inherit, sonnet, opus, haiku or claude-* are allowed there.`,
      })
    }
  }

  return warnings
}

/** One log line naming the actors per lane, e.g. `session=[a, b] gateway=[c]`. */
export function summarizeLanes(actors: ActorEntry[]): string | null {
  const byLane: Record<ActorLane, string[]> = { session: [], gateway: [] }
  for (const actor of actors) {
    const lane = actorLane(actor)
    if (lane) byLane[lane].push(actor.slug)
  }
  if (byLane.session.length === 0 && byLane.gateway.length === 0) return null
  return `session=[${byLane.session.join(", ")}] gateway=[${byLane.gateway.join(", ")}]`
}

import type { RoutingWarning } from "./types.ts"

/**
 * Format routing divergence warnings as a deterministic tool-output banner
 * (core module), runtime-agnostic text, unchanged wording from the
 * original plugin except generalized from "OpenCode instance" to "runtime
 * instance" so it reads correctly from either adapter.
 */
const LANE_CODES = new Set<RoutingWarning["code"]>([
  "session_model_not_allowed",
  "gateway_actor_in_session",
  "unresolved_actor_model",
])

export function formatBanner(warnings: RoutingWarning[]): string {
  const lines = warnings.map((w) => `  - [${w.code}] ${w.message}`)
  const laneHint = warnings.some((w) => LANE_CODES.has(w.code))
    ? "Lane warnings: fix the actor's model profile or lane on the Nexus side and re-run " +
      "`nexus pull`; gateway-lane actors run only in a gateway-backed process, never as " +
      "subagents of this session.\n"
    : ""
  return (
    "<system-reminder>\n" +
    "[nexus-routing-guard] Model routing divergence detected between the " +
    "Nexus-configured agents and what this runtime instance can actually " +
    "serve. Report this to the user verbatim before proceeding:\n" +
    lines.join("\n") +
    "\n" +
    "Remediation: check the affected agent's model in opencode.json (or the " +
    "equivalent Claude Code project config) against the provider catalog " +
    "(`nexus pull` may need a re-run if this was fixed on the Nexus side), " +
    "or ensure the provider is configured in this runtime instance.\n" +
    laneHint +
    "</system-reminder>"
  )
}

/** Format routing divergence warnings for injection into the system prompt (OpenCode-only mechanism). */
export function formatSystemPromptContext(warnings: RoutingWarning[]): string {
  const lines = warnings.map((w) => `- [${w.code}] ${w.message}`)
  return (
    "Nexus routing guard detected model routing divergence. Report this to " +
    "the user verbatim before proceeding with other work:\n" +
    lines.join("\n")
  )
}

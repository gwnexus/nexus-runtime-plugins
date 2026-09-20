import type { AgentInfo, ProviderCatalog, RoutingWarning } from "./types.ts"

/**
 * Compare the resolved agent model routing against a provider/model catalog
 * (ADR-C05 core module) — runtime-agnostic pure function, unchanged from the
 * original plugin.
 *
 * - `unknown_provider`: the agent's providerID is not in the catalog at all.
 * - `unknown_model`: the provider exists and is serviceable, but the
 *   modelID is not in that provider's model set. This is the bug class
 *   that motivated this plugin — provider-level checks are blind to it.
 *
 * Agents without an explicit `model` inherit the instance default and are
 * valid by construction; they are never checked.
 */
export function detectRoutingWarnings(catalog: ProviderCatalog, agents: AgentInfo[]): RoutingWarning[] {
  const byId = new Map(catalog.providers.map((p) => [p.id, p]))
  const warnings: RoutingWarning[] = []

  for (const agent of agents) {
    if (!agent.model) continue

    const { providerID, modelID } = agent.model
    const provider = byId.get(providerID)

    if (!provider) {
      warnings.push({
        code: "unknown_provider",
        agent: agent.name,
        provider: providerID,
        model: modelID,
        message: `Agent "${agent.name}" is routed to provider "${providerID}", which this runtime instance does not have configured.`,
      })
      continue
    }

    if (!(modelID in provider.models)) {
      warnings.push({
        code: "unknown_model",
        agent: agent.name,
        provider: providerID,
        model: modelID,
        message: `Agent "${agent.name}" is routed to "${providerID}/${modelID}", but provider "${providerID}" does not serve a model with that id.`,
      })
    }
  }

  return warnings
}

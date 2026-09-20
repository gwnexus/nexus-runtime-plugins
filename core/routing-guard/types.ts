/**
 * nexus-routing-guard core types (ADR-C05 core module) — runtime-agnostic.
 */

export type RoutingWarning = {
  code: "unknown_provider" | "unknown_model"
  agent: string
  provider: string
  model: string
  message: string
}

export type ProviderCatalog = {
  providers: Array<{
    id: string
    models: Record<string, unknown>
  }>
}

export type AgentInfo = {
  name: string
  model?: { providerID: string; modelID: string }
}

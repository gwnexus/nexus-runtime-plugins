/**
 * nexus-routing-guard core types (core module), runtime-agnostic.
 */

export type RoutingWarning = {
  code:
    | "unknown_provider"
    | "unknown_model"
    | "session_model_not_allowed"
    | "gateway_actor_in_session"
    | "unresolved_actor_model"
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

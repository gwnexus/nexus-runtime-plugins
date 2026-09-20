import type { AgentInfo, ProviderCatalog } from "./types.ts"

/**
 * Transform for the real nexus-cli-generated routing files (ADR-C05 core
 * module), confirmed live against nexus-cli v0.17.2 on 2026-09-20 (see
 * Dispatch dc5fdf9a reply from nexus-app):
 *
 *   .nexus/generated/routing-catalog.json  -> { model_routes: ModelRoute[] }
 *   .nexus/generated/agent-routing.json    -> { actors: ActorEntry[] }
 *
 * These mirror `runtime_spec.model_routes` / `runtime_spec.actors` shipped
 * in nexus-cli commit db5d053. `detectRoutingWarnings()` (detect.ts) still
 * operates on the plugin's own `ProviderCatalog`/`AgentInfo[]` shapes; these
 * functions convert the real files into that shape so the shared core
 * detection logic doesn't need to know about nexus-cli's file format.
 *
 * ASSUMPTION (not yet confirmed by nexus-app, flagged in the adapter
 * README): an actor's `model_profile_id` corresponds 1:1 to a model route's
 * `route_alias`. If nexus-cli's actual linkage differs, this mapping will
 * need correction.
 */

export interface ModelRoute {
  route_alias: string
  provider: string
  model: string
  lifecycle_status?: string
}

export interface RoutingCatalogFile {
  model_routes: ModelRoute[]
}

export interface ActorEntry {
  slug: string
  title?: string
  summary?: string
  role_override?: string
  is_primary?: boolean
  priority?: number
  model_profile_id?: string
}

export interface AgentRoutingFile {
  actors: ActorEntry[]
}

/** Build a ProviderCatalog from nexus-cli's routing-catalog.json. */
export function buildProviderCatalogFromRoutes(file: RoutingCatalogFile): ProviderCatalog {
  const byProvider = new Map<string, Record<string, unknown>>()

  for (const route of file.model_routes ?? []) {
    if (!route.provider || !route.model) continue
    if (!byProvider.has(route.provider)) byProvider.set(route.provider, {})
    byProvider.get(route.provider)![route.model] = {}
  }

  return {
    providers: Array.from(byProvider.entries()).map(([id, models]) => ({ id, models })),
  }
}

/**
 * Build an AgentInfo[] from nexus-cli's agent-routing.json, resolving each
 * actor's `model_profile_id` against the routing catalog's `route_alias` to
 * recover the provider/model pair `detectRoutingWarnings()` needs.
 *
 * Actors with no `model_profile_id`, or whose id does not match any known
 * route_alias, are returned without a `model` field -- matching
 * `detectRoutingWarnings()`'s existing behavior of never checking agents
 * that have no explicit model (inherits instance default, valid by
 * construction).
 */
export function buildAgentInfoFromActors(agentFile: AgentRoutingFile, catalogFile: RoutingCatalogFile): AgentInfo[] {
  const routeByAlias = new Map(
    (catalogFile.model_routes ?? []).filter((r) => r.route_alias).map((r) => [r.route_alias, r]),
  )

  return (agentFile.actors ?? []).map((actor) => {
    const route = actor.model_profile_id ? routeByAlias.get(actor.model_profile_id) : undefined
    return {
      name: actor.slug,
      ...(route ? { model: { providerID: route.provider, modelID: route.model } } : {}),
    }
  })
}

import type { AgentInfo, ProviderCatalog } from "./types.ts"

/**
 * Transform for the real nexus-cli-generated routing files (core module),
 * confirmed live against nexus-cli v0.17.2 on 2026-09-20:
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
 * Actor-to-route linkage: newer hubs resolve each actor once and ship
 * `profile_slug` (authoritative), `route_alias` (legacy fallback), `lane`,
 * `session_model` and `model_status` per actor. The actor's route is looked up by
 * `profile_slug`, then `route_alias`. `model_profile_id` is a UUID and never
 * equals a `route_alias`; it is used as a lookup key only for files that
 * carry neither slug nor alias, which keeps the behaviour for older hubs.
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
  /** Resolved by the hub (runtime_spec); absent on older hubs. */
  profile_slug?: string
  route_alias?: string
  lane?: string
  /** explicit | profile | route | default */
  lane_source?: string
  session_model?: string
  /** resolved | unresolved_alias | unbound */
  model_status?: string
  /** Pre-release name of `model_status`; read as a fallback. */
  status?: string
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

/** Key used to find an actor's route: profile slug, then route alias, then (older hubs) model_profile_id. */
export function actorRouteKey(actor: ActorEntry): string | undefined {
  return actor.profile_slug || actor.route_alias || actor.model_profile_id || undefined
}

/**
 * Build an AgentInfo[] from nexus-cli's agent-routing.json, resolving each
 * actor's route key (`actorRouteKey`) against the routing catalog's
 * `route_alias` to recover the provider/model pair `detectRoutingWarnings()`
 * needs.
 *
 * Actors without a route key, or whose key does not match any known
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
    const key = actorRouteKey(actor)
    const route = key ? routeByAlias.get(key) : undefined
    return {
      name: actor.slug,
      ...(route ? { model: { providerID: route.provider, modelID: route.model } } : {}),
    }
  })
}

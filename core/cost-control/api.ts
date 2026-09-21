import type { NexusConfig, HeliconeSessionCost } from "./types.ts"
import { formatCostSummary } from "./format.ts"

/**
 * Append a cost-snapshot entry to the Nexus session via REST API (ADR-C05
 * core module) — runtime-agnostic (fetch only). Unchanged from the original
 * plugin.
 */
export async function appendCostEntry(
  nexusConfig: NexusConfig,
  sessionId: string,
  cost: HeliconeSessionCost,
  pluginMeta: { name: string; version: string },
  onLog?: (level: "info" | "error", message: string) => void,
): Promise<void> {
  const url = `${nexusConfig.apiUrl}/api/mcp/sessions`
  const summary = formatCostSummary(cost, pluginMeta.version)

  const payload = {
    action: "session_append",
    session_id: sessionId,
    entry_type: "cost_snapshot",
    summary,
    metadata: JSON.stringify({
      plugin: pluginMeta.name,
      plugin_version: pluginMeta.version,
      tokens_input: cost.tokensInput,
      tokens_output: cost.tokensOutput,
      tokens_cache_read: cost.tokensCacheRead,
      tokens_cache_write: cost.tokensCacheWrite,
      total_tokens: cost.totalTokens,
      total_messages: cost.totalMessages ?? null,
      cost_usd: cost.costUsd,
      cost_source: cost.costSource ?? "helicone",
      total_requests: cost.totalRequests,
      models: cost.models,
      helicone_session_id: cost.nexusSessionId,
    }),
  }

  onLog?.("info", `Appending cost entry to Nexus session ${sessionId}`)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${nexusConfig.token}`,
    },
    body: JSON.stringify(payload),
  })

  const body = await res.text().catch(() => "")
  onLog?.("info", `Response ${res.status}: ${body.substring(0, 200)}`)

  if (!res.ok) {
    throw new Error(`Nexus API ${res.status}: ${body}`)
  }
}

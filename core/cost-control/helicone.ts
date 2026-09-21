import type { HeliconeConfig, HeliconeSessionCost } from "./types.ts"

/**
 * Query the Helicone API for aggregated usage data for a specific Nexus
 * session (ADR-C05 core module) — runtime-agnostic (fetch only). Helicone
 * groups requests by session via the `Helicone-Session-Id` header that
 * agents inject on each request.
 *
 * API reference: https://docs.helicone.ai/rest/request/post-v1requestquery
 */
export async function queryHeliconeSession(
  heliconeConfig: HeliconeConfig,
  nexusSessionId: string,
  onLog?: (level: "info" | "error", message: string) => void,
): Promise<HeliconeSessionCost | null> {
  const url = "https://api.helicone.ai/v1/request/query"

  const payload = {
    filter: {
      request: {
        properties: {
          "Helicone-Session-Id": { equals: nexusSessionId },
        },
      },
    },
    limit: 1000,
    offset: 0,
    sort: { created_at: "desc" },
  }

  onLog?.("info", `Querying Helicone for session ${nexusSessionId}`)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${heliconeConfig.apiKey}`,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      onLog?.("error", `Helicone API ${res.status}: ${body}`)
      return null
    }

    const data = (await res.json()) as {
      data?: Array<{
        request?: {
          model?: string
          prompt_tokens?: number
          completion_tokens?: number
          prompt_cache_read_tokens?: number
          prompt_cache_write_tokens?: number
          helicone_cost?: number
        }
      }>
    }

    const requests = data.data ?? []
    onLog?.("info", `Helicone returned ${requests.length} requests for session`)

    if (requests.length === 0) return null

    let tokensInput = 0
    let tokensOutput = 0
    let tokensCacheRead = 0
    let tokensCacheWrite = 0
    let costUsd = 0
    const modelsSet = new Set<string>()

    for (const req of requests) {
      const r = req.request
      if (!r) continue
      tokensInput += r.prompt_tokens ?? 0
      tokensOutput += r.completion_tokens ?? 0
      tokensCacheRead += r.prompt_cache_read_tokens ?? 0
      tokensCacheWrite += r.prompt_cache_write_tokens ?? 0
      costUsd += r.helicone_cost ?? 0
      if (r.model) modelsSet.add(r.model)
    }

    return {
      nexusSessionId,
      totalRequests: requests.length,
      tokensInput,
      tokensOutput,
      tokensCacheRead,
      tokensCacheWrite,
      totalTokens: tokensInput + tokensOutput,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
      costSource: "helicone",
      models: Array.from(modelsSet),
      queriedAt: new Date().toISOString(),
    }
  } catch (err) {
    onLog?.("error", `Helicone query failed: ${err}`)
    return null
  }
}

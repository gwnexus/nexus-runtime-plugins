import type { HeliconeSessionCost } from "./types.ts"

/**
 * Format a HeliconeSessionCost as a human-readable Nexus session entry
 * (ADR-C05 core module) — runtime-agnostic, unchanged from the original
 * plugin.
 */
export function formatCostSummary(cost: HeliconeSessionCost, pluginVersion: string): string {
  const time = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })

  const lines = [
    `## Token & Cost Summary — ${time}`,
    ``,
    `Tracked via [Helicone](https://helicone.ai) · nexus-cost-control v${pluginVersion}`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Requests | ${cost.totalRequests} |`,
    `| Input tokens | ${cost.tokensInput.toLocaleString()} |`,
    `| Output tokens | ${cost.tokensOutput.toLocaleString()} |`,
    `| Cache read tokens | ${cost.tokensCacheRead.toLocaleString()} |`,
    `| Cache write tokens | ${cost.tokensCacheWrite.toLocaleString()} |`,
    `| **Total tokens** | **${cost.totalTokens.toLocaleString()}** |`,
    `| **Estimated cost** | **$${cost.costUsd.toFixed(6)}** |`,
  ]

  if (cost.models.length > 0) {
    lines.push(`| Models | ${cost.models.join(", ")} |`)
  }

  return lines.join("\n")
}

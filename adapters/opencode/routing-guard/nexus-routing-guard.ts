import { type Plugin } from "@opencode-ai/plugin"
import { createFileLogger } from "../../../core/logger.ts"
import { detectRoutingWarnings } from "../../../core/routing-guard/detect.ts"
import { formatBanner, formatSystemPromptContext } from "../../../core/routing-guard/format.ts"
import type { AgentInfo, ProviderCatalog, RoutingWarning } from "../../../core/routing-guard/types.ts"

/**
 * Nexus Routing Guard — OpenCode adapter (ADR-C05, Track B2).
 *
 * Wires the runtime-agnostic core/routing-guard detection + formatting logic
 * to OpenCode's `experimental.chat.system.transform` (best-effort in-session
 * delivery) and `tool.execute.after` (one-shot deterministic banner) hooks.
 * The provider/agent catalog query (`client.config.providers()` /
 * `client.app.agents()`) is OpenCode-SDK-specific and stays in this adapter;
 * `detectRoutingWarnings()` and the banner/context formatters are shared
 * verbatim with the Claude Code adapter.
 *
 * Re-exports `detectRoutingWarnings` for backward-compatible test imports.
 */
export { detectRoutingWarnings }

const PLUGIN_META = {
  name: "nexus-routing-guard",
  version: "1.0.0",
  description:
    "Detects model routing divergence between Nexus-configured agents and the effective merged OpenCode provider/model catalog, and surfaces a one-shot warning.",
} as const

const ENV_ENABLED = "NEXUS_ROUTING_GUARD_ENABLED"

export const NexusRoutingGuard: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const fileLog = createFileLogger(directory, "routing-guard.log")

  const enabled = process.env[ENV_ENABLED] !== "false"

  let checked = false
  let bannerFiredThisSession = false
  let cachedWarnings: RoutingWarning[] | null = null

  fileLog("info", "=== Plugin initializing ===")
  fileLog("info", `Enabled: ${enabled}`)

  if (!enabled) {
    fileLog("info", `Disabled via ${ENV_ENABLED}=false`)
  }

  async function runCheck(): Promise<RoutingWarning[]> {
    if (checked && cachedWarnings) return cachedWarnings
    checked = true

    try {
      const providersRes = await client.config.providers()
      const agentsRes = await client.app.agents()

      const providers = (providersRes as { data?: ProviderCatalog }).data ?? (providersRes as unknown as ProviderCatalog)
      const agents = (agentsRes as { data?: AgentInfo[] }).data ?? (agentsRes as unknown as AgentInfo[])

      const warnings = detectRoutingWarnings(providers, agents ?? [])
      cachedWarnings = warnings

      if (warnings.length > 0) {
        fileLog("warn", `${warnings.length} routing warning(s): ${warnings.map((w) => `${w.agent}:${w.code}`).join(", ")}`)
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "warn",
            message: `Routing divergence: ${warnings.map((w) => w.message).join(" | ")}`,
          },
        })
      } else {
        fileLog("debug", "No routing divergence detected")
      }

      return warnings
    } catch (err) {
      fileLog("error", `Check failed, degrading silently: ${String(err)}`)
      cachedWarnings = []
      return []
    }
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!enabled) return
      const warnings = await runCheck()
      if (warnings.length === 0) return
      output.system.push(formatSystemPromptContext(warnings))
    },

    "tool.execute.after": async (_input, output) => {
      if (!enabled) return
      if (bannerFiredThisSession) return

      const warnings = await runCheck()
      if (warnings.length === 0) {
        bannerFiredThisSession = true
        return
      }

      bannerFiredThisSession = true
      fileLog("info", `Injecting one-shot routing banner (${warnings.length} warning(s))`)

      const raw = output as Record<string, unknown>
      const banner = formatBanner(warnings)
      if (typeof raw.output === "string") {
        raw.output = raw.output + "\n\n" + banner
      } else if (Array.isArray(raw.content)) {
        raw.content.push({ type: "text", text: "\n\n" + banner })
      }
    },
  }
}

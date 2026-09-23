import { type Plugin, tool } from "@opencode-ai/plugin"
import { createFileLogger } from "../../../core/logger.ts"
import { getNexusConfig, getHeliconeConfig } from "../../../core/cost-control/config.ts"
import { tryParseJson, extractNexusState } from "../../../core/cost-control/state.ts"
import { queryHeliconeSession } from "../../../core/cost-control/helicone.ts"
import { formatCostSummary } from "../../../core/cost-control/format.ts"
import { appendCostEntry } from "../../../core/cost-control/api.ts"
import { emptyRuntimeUsage, buildRuntimeCostEntry, type RuntimeUsage } from "../../../core/cost-control/runtime-usage.ts"
import type { NormalizedToolCall } from "../../../core/cost-control/types.ts"

/**
 * Nexus Cost Control — OpenCode adapter (ADR-C05, Track B2).
 *
 * Wires the runtime-agnostic core/cost-control logic (credential resolution,
 * state extraction, Helicone query, formatting, Nexus API call) to
 * OpenCode's `event` (`session.idle`, debounced cost-snapshot recording)
 * hook and the `nexus_cost_summary` / `nexus_show_plugins` tools. Parsing
 * OpenCode's message/part shape into the shared `NormalizedToolCall[]`
 * format is the only OpenCode-specific concern left in this file.
 *
 * Precedence (per ADR-0040, nexus-app; corrected 2026-09-23, Dispatch
 * `6298a740` after drift was found during the ADR-C05 restructure): native
 * OpenCode message-data aggregation (`aggregateOpenCodeUsage`) is the
 * default, zero-configuration cost/usage source and always runs. Helicone
 * is optional, opt-in enrichment — if `HELICONE_API_KEY` is configured, it
 * is queried in addition and its result (with a real metered `cost_usd`) is
 * preferred over the native token-only entry when it returns data.
 */
const PLUGIN_META = {
  name: "nexus-cost-control",
  version: "1.2.0",
  description:
    "Token usage and cost tracking for Nexus sessions. Aggregates token " +
    "counts directly from the runtime's own message data with zero " +
    "configuration required; optionally enriches with metered dollar cost " +
    "from Helicone if HELICONE_API_KEY is configured.",
} as const

interface ToolPartShape {
  type: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown>; output?: string }
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
}

interface AssistantMessageInfo {
  role: string
  modelID?: string
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
}

/**
 * Aggregate token usage directly from OpenCode's native message data
 * (`info.tokens`), used as a fallback cost-control source when Helicone has
 * no data for a session (Dispatch 515186c1). No cost figure is derivable
 * here — only Helicone knows the metered dollar cost.
 */
export function aggregateOpenCodeUsage(
  messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
): RuntimeUsage {
  const usage = emptyRuntimeUsage()
  const modelsSet = new Set<string>()

  for (const msg of messages) {
    const info = msg.info as unknown as AssistantMessageInfo
    if (info.role !== "assistant") continue

    usage.totalMessages += 1
    const tokens = info.tokens
    if (tokens) {
      usage.tokensInput += tokens.input ?? 0
      usage.tokensOutput += tokens.output ?? 0
      usage.tokensCacheRead += tokens.cache?.read ?? 0
      usage.tokensCacheWrite += tokens.cache?.write ?? 0
    }
    if (info.modelID) modelsSet.add(info.modelID)
  }

  usage.totalTokens = usage.tokensInput + usage.tokensOutput
  usage.models = Array.from(modelsSet)
  return usage
}

/** Convert OpenCode session messages into the shared NormalizedToolCall[] shape. */
function normalizeOpenCodeMessages(
  messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = []

  for (const msg of messages) {
    for (const rawPart of msg.parts ?? []) {
      const part = rawPart as unknown as ToolPartShape
      if (part.type !== "tool" && part.type !== "tool-invocation") continue

      const toolName = (part.tool ?? part.toolName ?? "") as string
      if (!toolName) continue

      const args = (part.state?.input ?? part.args ?? {}) as Record<string, unknown>

      let result: Record<string, unknown> | null = null
      if (part.state?.output) {
        result = tryParseJson(part.state.output)
      } else if (part.result && typeof part.result === "object") {
        result = part.result as Record<string, unknown>
      }

      calls.push({ tool: toolName, args, result })
    }
  }

  return calls
}

export const NexusCostControl: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const fileLog = createFileLogger(directory, "cost-control.log")
  const nexusConfig = getNexusConfig(directory)
  const heliconeConfig = getHeliconeConfig(directory)
  const loadedAt = new Date().toISOString()

  fileLog("info", "=== nexus-cost-control initializing ===")
  fileLog("info", `Directory: ${directory}`)
  fileLog("info", nexusConfig ? `Nexus API: ${nexusConfig.apiUrl}` : "WARNING: Nexus credentials not found")
  fileLog(
    "info",
    heliconeConfig ? "Helicone: API key configured" : "WARNING: HELICONE_API_KEY not set — cost tracking disabled",
  )

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: `Plugin loaded — Nexus: ${nexusConfig ? nexusConfig.apiUrl : "NOT CONFIGURED"} | Helicone: ${heliconeConfig ? "configured" : "NOT CONFIGURED"}`,
    },
  })

  /**
   * Idle debounce: we only want to record a cost entry once per "work burst",
   * not on every idle event. We track the last append time and only write to
   * Nexus if at least IDLE_DEBOUNCE_MS have passed since the last one.
   */
  const IDLE_DEBOUNCE_MS = 5 * 60 * 1000 // 5 minutes
  let lastAppendAt: number | null = null
  let lastAppendedTokens: number | null = null

  return {
    tool: {
      nexus_cost_summary: tool({
        description:
          "Show token usage and estimated cost for the current Nexus session. " +
          "Returns input/output/cache token counts, aggregated natively from " +
          "the runtime with zero configuration required, enriched with metered " +
          "USD cost if HELICONE_API_KEY is configured. Use this to give the " +
          "user a cost overview or before closing a session.",
        args: {},
        async execute() {
          let nexusSessionId: string | undefined
          let sessionMessages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }> = []
          try {
            const sessions = await client.session.list({})
            const activeSessions = sessions.data ?? []
            if (activeSessions.length > 0) {
              const latestSession = activeSessions[0]
              const msgs = await client.session.messages({ path: { id: (latestSession as { id: string }).id } })
              sessionMessages = (msgs.data ?? []) as Array<{
                info: { role: string }
                parts: Array<Record<string, unknown>>
              }>
              const calls = normalizeOpenCodeMessages(sessionMessages)
              const state = extractNexusState(calls, (m) => fileLog("debug", m))
              nexusSessionId = state.sessionId
            }
          } catch (err) {
            fileLog("error", `Failed to fetch session for tool: ${err}`)
          }

          if (!nexusSessionId) {
            return "No active Nexus session found. Start a session with nexus_session_create first."
          }

          const usage = aggregateOpenCodeUsage(sessionMessages)

          let cost = heliconeConfig
            ? await queryHeliconeSession(heliconeConfig, nexusSessionId, (level, msg) => fileLog(level, msg))
            : null

          if (!cost) {
            if (usage.totalMessages === 0) {
              return `No usage data found for session \`${nexusSessionId}\` yet.`
            }
            cost = buildRuntimeCostEntry(nexusSessionId, usage)
          }

          return formatCostSummary(cost, PLUGIN_META.version)
        },
      }),

      nexus_show_plugins: tool({
        description: "Show all loaded Nexus plugins, their versions, and connection status",
        args: {},
        async execute() {
          const nexusStatus = nexusConfig ? `connected (${nexusConfig.apiUrl})` : "disconnected — credentials missing"
          const heliconeStatus = heliconeConfig ? "connected — API key set" : "disconnected — HELICONE_API_KEY not set"

          return [
            `## Nexus Plugins`,
            ``,
            `| Plugin | Version | Status | Loaded |`,
            `|--------|---------|--------|--------|`,
            `| ${PLUGIN_META.name} | ${PLUGIN_META.version} | Nexus: ${nexusStatus} · Helicone: ${heliconeStatus} | ${loadedAt} |`,
            ``,
            `**Description:** ${PLUGIN_META.description}`,
            ``,
            `### Hooks registered`,
            `- \`event (session.idle)\` — aggregates native token usage and records cost entry in active Nexus session (debounced: 5 min); enriches with Helicone cost if configured`,
            ``,
            `### Tools registered`,
            `- \`nexus_cost_summary\` — on-demand live usage snapshot (native, Helicone-enriched if configured)`,
            `- \`nexus_show_plugins\` — this overview`,
          ].join("\n")
        },
      }),
    },

    event: async ({ event }) => {
      const eventType = event.type as string

      if (eventType !== "session.idle") return
      if (!nexusConfig) return

      if (lastAppendAt && Date.now() - lastAppendAt < IDLE_DEBOUNCE_MS) {
        fileLog("debug", `session.idle — skipping (last append ${Date.now() - lastAppendAt}ms ago)`)
        return
      }

      const sessionID = (event as unknown as { properties: { sessionID: string } }).properties?.sessionID

      if (!sessionID) {
        fileLog("warn", "session.idle — no sessionID in event")
        return
      }

      fileLog("info", `session.idle fired — sessionID=${sessionID}`)

      try {
        const { data } = await client.session.messages({ path: { id: sessionID } })
        if (!data) return

        const messages = data as Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>
        const calls = normalizeOpenCodeMessages(messages)
        const state = extractNexusState(calls, (m) => fileLog("debug", m))

        if (!state.sessionId) {
          fileLog("info", "No Nexus session ID found — skipping cost recording")
          return
        }

        const cost = heliconeConfig
          ? await queryHeliconeSession(heliconeConfig, state.sessionId, (level, msg) => fileLog(level, msg))
          : null
        let entry = cost
        if (!entry) {
          const usage = aggregateOpenCodeUsage(messages)
          if (usage.totalMessages === 0) {
            fileLog("info", `No usage data for session ${state.sessionId} — skipping`)
            return
          }
          entry = buildRuntimeCostEntry(state.sessionId, usage)
          fileLog(
            "info",
            `Recording native token aggregation for session ${state.sessionId} (cost_source=runtime${heliconeConfig ? ", Helicone configured but returned no data" : ""})`,
          )
        }

        if (lastAppendedTokens !== null && entry.totalTokens === lastAppendedTokens) {
          fileLog("debug", `session.idle — skipping (no token delta, still ${entry.totalTokens})`)
          return
        }

        await appendCostEntry(nexusConfig, state.sessionId, entry, PLUGIN_META, (level, msg) => fileLog(level, msg))

        lastAppendAt = Date.now()
        lastAppendedTokens = entry.totalTokens

        const costLabel = entry.costUsd === null ? "n/a (runtime)" : `$${entry.costUsd.toFixed(6)}`
        fileLog("info", `Cost entry recorded — ${costLabel} / ${entry.totalTokens} tokens`)
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "info",
            message: `Cost snapshot recorded in Nexus session ${state.sessionId}: ${costLabel} / ${entry.totalTokens} tokens`,
          },
        })
      } catch (err) {
        fileLog("error", `session.idle handler failed: ${err}`)
        await client.app.log({
          body: { service: PLUGIN_META.name, level: "error", message: `Failed to record cost entry: ${err}` },
        })
      }
    },
  }
}

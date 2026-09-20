import { type Plugin, tool } from "@opencode-ai/plugin"
import { createFileLogger } from "../../../core/logger.ts"
import { getNexusConfig } from "../../../core/compaction-plus/config.ts"
import { tryParseJson, extractNexusState, buildNexusContext, cleanCompactedText, buildCompactionSummary } from "../../../core/compaction-plus/state.ts"
import { appendCompactionEntry } from "../../../core/compaction-plus/api.ts"
import type { NormalizedToolCall } from "../../../core/compaction-plus/types.ts"

/**
 * Nexus Compaction Plus — OpenCode adapter (ADR-C05, Track B2).
 *
 * Wires the runtime-agnostic core/compaction-plus logic to OpenCode's
 * `experimental.session.compacting` (pre-compaction context injection) and
 * `event` (`session.compacted` + `message.updated`, post-compaction summary
 * recording) hooks. Parsing OpenCode's message/part shape into the shared
 * `NormalizedToolCall[]` format is the only OpenCode-specific concern left
 * in this file; everything else (state extraction, context building, the
 * Nexus API call) lives in core/compaction-plus/*.
 */
const PLUGIN_META = {
  name: "nexus-compaction-plus",
  version: "1.8.1",
  description:
    "Preserves Nexus session context across compaction and records compaction events in the active session.",
} as const

/**
 * OpenCode SDK message/part types (from @opencode-ai/sdk types.gen.d.ts):
 *
 *   ToolPart = { type: "tool", tool: string, state: ToolState, ... }
 *   ToolState = { status: string, input: Record<string,unknown>, output?: string, ... }
 *
 * - `part.tool`        = tool name (e.g. "nexus_session_create")
 * - `part.state.input` = tool arguments
 * - `part.state.output` = JSON string of the tool result (only when status=completed)
 */
interface ToolPartShape {
  type: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
  }
  // Legacy/fallback fields (Vercel AI SDK shape)
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
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

interface PendingCompaction {
  openCodeSessionId: string
  timestamp: Date
}

export const NexusCompactionPlus: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const fileLog = createFileLogger(directory, "compaction-plus.log")
  const nexusConfig = getNexusConfig(directory)
  const loadedAt = new Date().toISOString()
  let pendingCompaction: PendingCompaction | null = null

  fileLog("info", "=== Plugin initializing ===")
  fileLog("info", `Directory: ${directory}`)
  fileLog(
    "info",
    nexusConfig
      ? `Nexus API configured: ${nexusConfig.apiUrl}`
      : "WARNING: Nexus credentials not found — post-compaction recording disabled",
  )

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: nexusConfig
        ? `Plugin loaded — Nexus API: ${nexusConfig.apiUrl}`
        : "Plugin loaded — WARNING: NEXUS_API_URL/NEXUS_PRIVATE_TOKEN not set, post-compaction recording disabled",
    },
  })

  return {
    tool: {
      nexus_show_plugins: tool({
        description: "Show all loaded Nexus plugins, their versions, and connection status",
        args: {},
        async execute() {
          const apiStatus = nexusConfig ? `connected (${nexusConfig.apiUrl})` : "disconnected — credentials missing"

          return [
            `## Nexus Plugins`,
            ``,
            `| Plugin | Version | API Status | Loaded |`,
            `|--------|---------|------------|--------|`,
            `| ${PLUGIN_META.name} | ${PLUGIN_META.version} | ${apiStatus} | ${loadedAt} |`,
            ``,
            `**Description:** ${PLUGIN_META.description}`,
            ``,
            `### Hooks registered`,
            `- \`experimental.session.compacting\` — injects Nexus session context into compaction prompt`,
            `- \`event (session.compacted)\` — records compaction event in active Nexus session`,
          ].join("\n")
        },
      }),
    },

    "experimental.session.compacting": async (input, output) => {
      fileLog("info", `=== session.compacting fired === sessionID=${input.sessionID}`)
      try {
        const { data } = await client.session.messages({ path: { id: input.sessionID } })

        if (!data) {
          fileLog("warn", "Could not fetch session messages — data is null/undefined")
          await client.app.log({
            body: { service: PLUGIN_META.name, level: "warn", message: "Could not fetch session messages" },
          })
          return
        }

        const messages = data as Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>
        fileLog("debug", `Fetched ${messages.length} messages from session`)
        const calls = normalizeOpenCodeMessages(messages)
        const state = extractNexusState(calls, (m) => fileLog("debug", m))

        if (!state.sessionId && !state.projectId) {
          fileLog("info", "No Nexus session/project detected — skipping context injection")
          await client.app.log({
            body: {
              service: PLUGIN_META.name,
              level: "info",
              message: "No active Nexus session detected — skipping context injection",
            },
          })
          return
        }

        output.context.push(buildNexusContext(state))

        fileLog("info", `Context injected: session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"}`)
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "info",
            message: `Injected Nexus context: session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"}`,
          },
        })
      } catch (err) {
        fileLog("error", `session.compacting failed: ${err}`)
        await client.app.log({
          body: { service: PLUGIN_META.name, level: "error", message: `Failed to inject compaction context: ${err}` },
        })
      }
    },

    /**
     * Post-compaction: two-phase approach.
     *
     * Phase 1 (session.compacted): The summary message doesn't exist yet at this
     * point, so we just record the OpenCode session ID and timestamp.
     *
     * Phase 2 (message.updated): Fires once the compacted summary is saved as a
     * message. We detect this by checking if a compaction is pending, then fetch
     * the messages, extract the summary text, and post it to Nexus.
     */
    event: async ({ event }) => {
      const eventType = event.type as string
      if (eventType !== "message.part.delta") {
        fileLog("info", `=== event fired === type=${eventType}`)
      }

      if (eventType === "session.compacted") {
        const sessionID = (event as unknown as { properties: { sessionID: string } }).properties?.sessionID

        fileLog("info", `session.compacted — OpenCode sessionID=${sessionID}`)
        fileLog("debug", `Full event: ${JSON.stringify(event)}`)

        if (!sessionID || !nexusConfig) {
          if (!nexusConfig) fileLog("warn", "No Nexus config — skipping")
          if (!sessionID) fileLog("warn", "No sessionID in event — skipping")
          return
        }

        pendingCompaction = { openCodeSessionId: sessionID, timestamp: new Date() }
        fileLog("info", `Pending compaction set — waiting for message.updated`)
        return
      }

      if (eventType === "message.updated" && pendingCompaction) {
        const elapsed = Date.now() - pendingCompaction.timestamp.getTime()
        if (elapsed > 30_000) {
          fileLog("warn", `Pending compaction expired (${elapsed}ms) — discarding`)
          pendingCompaction = null
          return
        }

        const pending = pendingCompaction
        pendingCompaction = null // consume immediately to avoid double-fire

        fileLog("info", `message.updated after compaction — extracting summary (${elapsed}ms after compaction)`)

        try {
          const { data } = await client.session.messages({ path: { id: pending.openCodeSessionId } })

          if (!data) {
            fileLog("warn", "Could not fetch session messages — data is null/undefined")
            return
          }

          const messages = data as Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>
          fileLog("debug", `Post-compaction: fetched ${messages.length} messages`)
          const calls = normalizeOpenCodeMessages(messages)
          const state = extractNexusState(calls, (m) => fileLog("debug", m))

          if (!state.sessionId) {
            fileLog("warn", "No Nexus session ID found — skipping compaction entry")
            return
          }

          const time = pending.timestamp.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })

          // Extract the compacted summary — after compaction the LAST assistant
          // message contains the compressed context (the summary is appended as
          // the final message, not the first).
          let compactedText = ""
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (msg.info?.role !== "assistant") continue
            for (const rawPart of msg.parts ?? []) {
              const part = rawPart as { type?: string; text?: string }
              if (part.type === "text" && part.text) {
                compactedText = part.text
                break
              }
            }
            if (compactedText) break
          }

          compactedText = cleanCompactedText(compactedText)

          fileLog("debug", `Compacted text length: ${compactedText.length}`)
          if (compactedText) {
            fileLog("debug", `Compacted text preview: ${compactedText.substring(0, 200)}...`)
          }

          const summary = buildCompactionSummary(PLUGIN_META.version, time, compactedText)

          await appendCompactionEntry(nexusConfig!, state.sessionId, summary, (level, msg) => fileLog(level, msg))

          fileLog("info", `Compaction entry recorded in Nexus session ${state.sessionId}`)
          await client.app.log({
            body: {
              service: PLUGIN_META.name,
              level: "info",
              message: `Recorded compaction entry in Nexus session ${state.sessionId} (summary: ${compactedText.length} chars)`,
            },
          })
        } catch (err) {
          fileLog("error", `Post-compaction message.updated handler failed: ${err}`)
          await client.app.log({
            body: { service: PLUGIN_META.name, level: "error", message: `Failed to record compaction entry: ${err}` },
          })
        }
        return
      }
    },
  }
}

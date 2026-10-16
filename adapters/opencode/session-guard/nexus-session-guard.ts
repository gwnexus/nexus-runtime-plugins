import { type Plugin } from "@opencode-ai/plugin"
import { createFileLogger } from "../../../core/logger.ts"
import {
  PLUGIN_META,
  initialState,
  onUserTurn,
  evaluateToolCompletion,
  REMINDER_MESSAGE,
} from "../../../core/session-guard/logic.ts"
import { checkReleaseLine } from "../../../core/session-guard/release-line.ts"
import { findGitTopLevel } from "../../../core/project-root.ts"

/**
 * Nexus Session Guard: OpenCode adapter.
 *
 * Wires the runtime-agnostic core/session-guard/logic.ts state machine to
 * OpenCode's plugin hooks. State is kept in memory since the OpenCode
 * plugin instance is long-lived for the duration of the session.
 *
 * Hooks:
 *   - tool.execute.after — core detection + reminder injection; also
 *     appends the release-line nudge (core/session-guard/release-line.ts)
 *     once to the first tool output, since OpenCode has no session-start
 *     context injection. The check runs once when the plugin loads.
 *   - event (message.updated, role=user) — user turn tracking
 */
export const NexusSessionGuard: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const fileLog = createFileLogger(directory, "session-guard.log")
  const state = initialState()
  let _lastSeenUserMsgId: string | null = null
  const releaseCheck = checkReleaseLine(findGitTopLevel(directory) ?? directory).catch(() => null)
  let releaseNudgeDelivered = false

  fileLog("info", "=== Plugin initializing ===")
  fileLog("info", `Directory: ${directory}`)

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: `Plugin loaded (v${PLUGIN_META.version}) — monitoring for missing session appends`,
    },
  })

  return {
    "tool.execute.after": async (input, output) => {
      if (!releaseNudgeDelivered) {
        releaseNudgeDelivered = true
        const release = await releaseCheck
        if (release?.action === "nudge") {
          fileLog("info", `Release-line nudge: ${release.message}`)
          appendToToolOutput(output as Record<string, unknown>, release.message)
        }
      }

      const toolName = String(input?.tool ?? "")
      const args = (input as Record<string, unknown>) ?? {}
      const result = evaluateToolCompletion(state, toolName, args)

      switch (result.action) {
        case "session_append_recorded":
          fileLog(
            "debug",
            `session_append detected — lastAppendTurnIndex set to ${state.lastAppendTurnIndex}`,
          )
          return
        case "not_a_trigger":
          return
        case "suppressed_already_recorded":
          fileLog(
            "debug",
            `Trigger tool ${toolName} — append already recorded (user=${state.lastUserTurnIndex}, append=${state.lastAppendTurnIndex})`,
          )
          return
        case "suppressed_below_threshold":
          fileLog(
            "debug",
            `Trigger tool ${toolName} — below threshold (${state.triggerCountThisTurn}/3), suppressing`,
          )
          return
        case "suppressed_already_reminded":
          fileLog("debug", `Trigger tool ${toolName} — reminder already fired this turn, suppressing`)
          return
        case "remind":
          break
      }

      fileLog(
        "info",
        `REMINDER #${state.reminderCount} — tool=${toolName}, user=${state.lastUserTurnIndex}, append=${state.lastAppendTurnIndex}`,
      )

      await client.app.log({
        body: {
          service: PLUGIN_META.name,
          level: "info",
          message: `Reminder #${state.reminderCount}: ${toolName} completed without session_append (user turn ${state.lastUserTurnIndex})`,
        },
      })

      appendToToolOutput(output as Record<string, unknown>, REMINDER_MESSAGE)
    },

    event: async ({ event }) => {
      const eventType = event.type as string

      // OpenCode does NOT emit message.created for user messages.
      // It emits message.updated with properties.info.role === 'user'.
      // Multiple message.updated events fire per user message (status
      // transitions, part updates), so we deduplicate by msgId.
      if (eventType === "message.updated") {
        const props = (event as unknown as { properties?: { info?: { role?: string; id?: string } } })
          .properties
        if (props?.info?.role === "user") {
          const msgId = props.info.id
          if (msgId && msgId !== _lastSeenUserMsgId) {
            _lastSeenUserMsgId = msgId
            onUserTurn(state)
            fileLog(
              "debug",
              `User turn ${state.lastUserTurnIndex} detected (msgId=${msgId}) — counters reset`,
            )
          }
        }
      }
    },
  }
}

function appendToToolOutput(raw: Record<string, unknown>, text: string): void {
  if (typeof raw.output === "string") {
    raw.output = raw.output + "\n\n" + text
  } else if (Array.isArray(raw.content)) {
    raw.content.push({
      type: "text",
      text: "\n\n" + text,
    })
  }
}

#!/usr/bin/env node
/**
 * Nexus Dispatch Inbox: Claude Code adapter.
 *
 * Connects running Claude Code sessions to the Nexus CLI's Dispatch runner
 * (`nexus dispatch listen`), which turns hub events into short notices and
 * pushes them into sessions through Claude Code's cross-session inbox.
 *
 * - `SessionStart` (mode `session-start`):
 *   1. Registers the session: writes
 *      `~/.config/nexus/state/dispatch/sessions/<session_id>.json`
 *      (`session_id`, `cwd`, `socket`, `token`, `started_at`; mode 0600,
 *      atomic) from `CLAUDE_CODE_MESSAGING_SOCKET` and
 *      `CLAUDE_CODE_MESSAGING_TOKEN`. Skipped when either is unset.
 *   2. Catch-up: adds notices of the session's Nexus project that neither the
 *      runner nor this hook has delivered yet as `additionalContext` (newest
 *      first, at most 10, from the last 7 days) and records them in
 *      `notices/<project_id>.delivered.claude.jsonl`.
 * - `SessionEnd` (mode `session-end`): deletes the session file.
 *
 * The token is written only to the session file. It never goes into logs,
 * `.nexus/` state, stdout or the Nexus API. Notices are short pointers; no
 * Dispatch body is read or forwarded. Always exits 0 and never blocks the
 * session. Disable with NEXUS_DISPATCH_INBOX=off.
 *
 * Hook configuration (.claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "hooks": [{ "type": "command", "command": "node adapters/claude-code/dispatch-inbox/nexus-dispatch-inbox.ts session-start" }] }
 *       ],
 *       "SessionEnd": [
 *         { "hooks": [{ "type": "command", "command": "node adapters/claude-code/dispatch-inbox/nexus-dispatch-inbox.ts session-end" }] }
 *       ]
 *     }
 *   }
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createFileLogger, type FileLogger } from "../../../core/logger.ts"
import { resolveProjectRoot } from "../../../core/project-root.ts"
import { isEntrypoint } from "../../../core/entrypoint.ts"
import { readProjectIdFromAgentsMd } from "../../../core/headroom-intercept/config.ts"
import { withObserverLock } from "../../../core/agent-observer/state.ts"
import { PLUGIN_META, dispatchStateDir, isSafeId } from "../../../core/dispatch-inbox/types.ts"
import { buildSessionFile, removeSessionFile, writeSessionFile } from "../../../core/dispatch-inbox/sessions.ts"
import {
  formatCatchup,
  noticesDir,
  readDeliveredIds,
  readNotices,
  recordDelivered,
  selectPending,
} from "../../../core/dispatch-inbox/notices.ts"

export interface DispatchInboxHookInput {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  source?: string
  reason?: string
}

export function isDispatchInboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NEXUS_DISPATCH_INBOX?.trim().toLowerCase()
  return !(v === "off" || v === "false" || v === "0")
}

/** `[project] id` from `.nexus/config.toml`, written by `nexus link` / `nexus pull`. */
export function readProjectIdFromConfigToml(projectRoot: string): string | null {
  try {
    const raw = readFileSync(join(projectRoot, ".nexus", "config.toml"), "utf-8")
    let inProject = false
    for (const line of raw.split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
      if (header) {
        inProject = header[1].trim() === "project"
        continue
      }
      const id = inProject ? line.match(/^\s*id\s*=\s*"([^"]+)"/)?.[1] : undefined
      if (id) return id
    }
    return null
  } catch {
    return null
  }
}

/** The session's Nexus project: env, then `.nexus/AGENTS.md`, then `.nexus/config.toml`. */
export function resolveProjectId(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const id =
    env.NEXUS_PROJECT_ID?.trim() || readProjectIdFromAgentsMd(projectRoot) || readProjectIdFromConfigToml(projectRoot)
  return isSafeId(id) ? id : null
}

/** SessionStart: register the session, then return catch-up context if any. */
export function handleSessionStart(
  input: DispatchInboxHookInput,
  projectRoot: string,
  log: FileLogger,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Record<string, unknown> | null {
  const stateDir = dispatchStateDir(env)
  if (!stateDir) {
    log("debug", "No home directory; dispatch inbox skipped")
    return null
  }

  const file = buildSessionFile(input.session_id, projectRoot, env, now)
  if (!file) {
    log("debug", "Session not registered: messaging socket or token not set, or no usable session id")
  } else if (writeSessionFile(stateDir, file)) {
    log("info", `Session ${file.session_id} registered for the Dispatch runner`)
  } else {
    log("warn", `Session ${file.session_id} could not be registered`)
  }

  const sessionId = isSafeId(input.session_id) ? input.session_id : null
  const projectId = resolveProjectId(projectRoot, env)
  if (!sessionId || !projectId) {
    log("debug", `Catch-up skipped: ${sessionId ? "no Nexus project id" : "no usable session id"}`)
    return null
  }

  const pending = withObserverLock(
    noticesDir(stateDir),
    () => {
      const notices = readNotices(stateDir, projectId)
      if (notices.length === 0) return []
      const due = selectPending(notices, readDeliveredIds(stateDir, projectId), now)
      if (due.length > 0 && !recordDelivered(stateDir, projectId, sessionId, due, now)) {
        log("warn", "Catch-up notices could not be recorded as delivered; not injected")
        return []
      }
      return due
    },
    `${projectId}.claude.lock`,
  )
  if (pending.length === 0) {
    log("debug", "Catch-up: no pending notices")
    return null
  }

  log(
    "info",
    `Catch-up: ${pending.length} notice(s) added to the session context (${pending.map((n) => n.id).join(", ")})`,
  )
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: formatCatchup(pending),
    },
  }
}

/** SessionEnd: remove the session file. */
export function handleSessionEnd(
  input: DispatchInboxHookInput,
  log: FileLogger,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const stateDir = dispatchStateDir(env)
  if (!stateDir) return
  const removed = removeSessionFile(stateDir, input.session_id)
  log("debug", `Session ${String(input.session_id ?? "?")} ${removed ? "unregistered" : "had no session file"}`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf-8")
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ""
  const raw = await readStdin()
  if (!isDispatchInboxEnabled()) process.exit(0)

  let input: DispatchInboxHookInput = {}
  try {
    input = JSON.parse(raw || "{}")
  } catch {
    process.exit(0)
  }

  const projectRoot = resolveProjectRoot(input.cwd)
  if (mode === "session-end") {
    const log: FileLogger = projectRoot ? createFileLogger(projectRoot, "dispatch-inbox.log") : () => {}
    handleSessionEnd(input, log)
    process.exit(0)
  }
  if (mode !== "session-start" || !projectRoot) process.exit(0)

  const output = handleSessionStart(input, projectRoot, createFileLogger(projectRoot, "dispatch-inbox.log"))
  if (output) process.stdout.write(JSON.stringify(output))
  process.exit(0)
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err instanceof Error ? err.message : "unknown"}\n`)
    process.exit(0)
  })
}

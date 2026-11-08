import { join } from "node:path"

/**
 * Dispatch inbox (core module): local files shared with the Nexus CLI's
 * Dispatch runner (`nexus dispatch listen`) under
 * `~/.config/nexus/state/dispatch/`.
 *
 * - `sessions/<session_id>.json`: one file per running session, written by
 *   this plugin (mode 0600). The runner pushes short notices into the
 *   session's cross-session inbox with the socket and token from this file.
 * - `notices/<project_id>.jsonl`: the notice queue, written only by the
 *   runner.
 * - `notices/<project_id>.delivered.runner.jsonl`: notices the runner pushed.
 * - `notices/<project_id>.delivered.claude.jsonl`: notices this plugin added
 *   as session-start context; written only here, append-only.
 *
 * Notices are short pointers (Dispatch id, title, peer); they never carry a
 * Dispatch body, and this module never fetches one.
 */

export const PLUGIN_META = {
  name: "nexus-dispatch-inbox",
  version: "1.0.0",
} as const

/** `sessions/<session_id>.json`, read by the runner. */
export interface SessionFile {
  session_id: string
  cwd: string
  socket: string
  token: string
  started_at: string
}

/** One line of `notices/<project_id>.jsonl` (fields this plugin reads). */
export interface Notice {
  id: string
  project_id?: string
  dispatch_id?: string
  kind?: string
  text: string
  created_at: string
}

/** One line of `notices/<project_id>.delivered.claude.jsonl`. */
export interface ClaudeDelivery {
  notice_id: string
  session_id: string
  at: string
}

/**
 * `~/.config/nexus/state/dispatch`, the Nexus CLI's state directory.
 * `NEXUS_DISPATCH_STATE_DIR` overrides it (tests, non-default homes).
 */
export function dispatchStateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.NEXUS_DISPATCH_STATE_DIR?.trim()
  if (override) return override
  const home = env.HOME?.trim() || env.USERPROFILE?.trim()
  return home ? join(home, ".config", "nexus", "state", "dispatch") : null
}

/** A session or project id that is safe as a file name. */
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..")
}

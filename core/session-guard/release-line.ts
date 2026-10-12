import { readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { getNexusConfig, readProjectIdFromAgentsMd } from "../headroom-intercept/config.ts"
import type { NexusConfig } from "../headroom-intercept/types.ts"

/**
 * Release-line nudge (runtime-agnostic). Projects that keep one Nexus session
 * per release line title it `staging/release-X.Y.Z: <focus>`. On session
 * start, when the project root is on a `staging/release-X.Y.Z` branch and no
 * open Nexus session title starts with that branch name, the adapters inject
 * one short line asking the agent to close the old session and start a
 * matching one. The guard never closes or creates sessions itself.
 */

export const RELEASE_BRANCH_RE = /^staging\/release-(\d+\.\d+\.\d+)$/

/** Set to `off`, `0` or `false` to disable the nudge (default on). */
export const RELEASE_NUDGE_ENV = "NEXUS_SESSION_GUARD_RELEASE_NUDGE"

/** Upper bound for the session lookup; a slow backend must not delay session start. */
export const SESSION_LOOKUP_TIMEOUT_MS = 3000

export interface OpenSession {
  title: string
}

export function isReleaseNudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[RELEASE_NUDGE_ENV]?.trim().toLowerCase()
  return !(v === "off" || v === "0" || v === "false")
}

/**
 * Current branch of the checkout at `projectRoot`, read from `HEAD` (a `.git`
 * directory, or the `gitdir:` a `.git` file points to for linked worktrees).
 * Filesystem only, no `git` subprocess. Null when not a git checkout or when
 * HEAD is detached.
 */
export function readGitBranch(projectRoot: string): string | null {
  try {
    const gitPath = join(projectRoot, ".git")
    let gitDir = gitPath
    if (statSync(gitPath).isFile()) {
      const m = readFileSync(gitPath, "utf-8").match(/^gitdir:\s*(.+)$/m)
      if (!m) return null
      const raw = m[1].trim()
      gitDir = isAbsolute(raw) ? raw : resolve(projectRoot, raw)
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    return ref ? ref[1] : null
  } catch {
    return null
  }
}

/** True when `title` belongs to the release line named by `branch`. */
export function titleMatchesBranch(title: string, branch: string): boolean {
  if (!title.startsWith(branch)) return false
  const next = title.charAt(branch.length)
  return next === "" || next === ":" || /\s/.test(next)
}

export type ReleaseLineResult =
  | { action: "skip"; reason: "no_branch" | "not_release_branch" | "sessions_unknown" }
  | { action: "in_line" }
  | { action: "nudge"; message: string }

/**
 * Decide whether to nudge. `openSessions` is null when the lookup failed or
 * was not possible; the guard stays silent then rather than guess.
 */
export function evaluateReleaseLine(branch: string | null, openSessions: OpenSession[] | null): ReleaseLineResult {
  if (!branch) return { action: "skip", reason: "no_branch" }
  if (!RELEASE_BRANCH_RE.test(branch)) return { action: "skip", reason: "not_release_branch" }
  if (!openSessions) return { action: "skip", reason: "sessions_unknown" }
  if (openSessions.some((s) => titleMatchesBranch(s.title, branch))) return { action: "in_line" }
  return { action: "nudge", message: formatReleaseNudge(branch, openSessions[0]?.title ?? null) }
}

export function formatReleaseNudge(branch: string, openTitle: string | null): string {
  const open = openTitle ? ` (open: "${truncate(openTitle, 80)}")` : " (no open session)"
  const close = openTitle ? "close it with a summary (/nexus-session-close) and " : ""
  return (
    `[nexus-session-guard] Branch ${branch} has no matching Nexus session${open}. ` +
    `Per project rule: ${close}start "${branch}: <focus>" (/nexus-init).`
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

/**
 * Open sessions of `projectId` via the Nexus REST API (`session_list`, which
 * returns open sessions only). Returns null on any failure or timeout.
 */
export async function fetchOpenSessions(
  config: NexusConfig,
  projectId: string,
  timeoutMs: number = SESSION_LOOKUP_TIMEOUT_MS,
): Promise<OpenSession[] | null> {
  try {
    const res = await fetch(`${config.apiUrl}/api/mcp/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ action: "session_list", project_id: projectId }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { sessions?: unknown }
    if (!Array.isArray(data.sessions)) return null
    return data.sessions
      .filter((s: any) => typeof s?.title === "string" && (s.status === undefined || s.status === "open"))
      .map((s: any) => ({ title: s.title as string }))
  } catch {
    return null
  }
}

/**
 * End to end for one session start: enabled check, branch, then (only on a
 * release branch) credentials, project id and the session lookup. Never throws.
 */
export async function checkReleaseLine(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  lookup: (config: NexusConfig, projectId: string) => Promise<OpenSession[] | null> = fetchOpenSessions,
  resolveConfig: (projectRoot: string) => NexusConfig | null = getNexusConfig,
): Promise<ReleaseLineResult | null> {
  if (!isReleaseNudgeEnabled(env)) return null
  const branch = readGitBranch(projectRoot)
  if (!branch || !RELEASE_BRANCH_RE.test(branch)) return evaluateReleaseLine(branch, null)
  const config = resolveConfig(projectRoot)
  const projectId = env.NEXUS_PROJECT_ID?.trim() || readProjectIdFromAgentsMd(projectRoot)
  const sessions = config && projectId ? await lookup(config, projectId) : null
  return evaluateReleaseLine(branch, sessions)
}

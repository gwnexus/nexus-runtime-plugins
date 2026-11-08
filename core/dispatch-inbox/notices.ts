import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ClaudeDelivery, Notice } from "./types.ts"

/**
 * Session-start catch-up from the runner's notice queue.
 *
 * A notice counts as delivered when its id appears in the runner's
 * (`.delivered.runner.jsonl`) or this plugin's (`.delivered.claude.jsonl`)
 * delivery file, for any session. Everything else, newest first and at most
 * `MAX_CATCHUP_NOTICES`, goes into the new session's context once and is then
 * recorded in `.delivered.claude.jsonl`. Notices older than
 * `CATCHUP_MAX_AGE_MS` are left out: they point at Dispatches the sweep at
 * session start shows anyway.
 */

export const MAX_CATCHUP_NOTICES = 10
export const CATCHUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TEXT = 300

export function noticesDir(stateDir: string): string {
  return join(stateDir, "notices")
}

function readJsonl(path: string): unknown[] {
  let body: string
  try {
    body = readFileSync(path, "utf-8")
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const line of body.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip a torn or malformed line
    }
  }
  return out
}

function isNotice(v: any): v is Notice {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    v.id !== "" &&
    typeof v.text === "string" &&
    typeof v.created_at === "string"
  )
}

export function readNotices(stateDir: string, projectId: string): Notice[] {
  return readJsonl(join(noticesDir(stateDir), `${projectId}.jsonl`)).filter(isNotice)
}

/** Ids of notices recorded as delivered by the runner or this plugin. */
export function readDeliveredIds(stateDir: string, projectId: string): Set<string> {
  const ids = new Set<string>()
  const dir = noticesDir(stateDir)
  for (const v of readJsonl(join(dir, `${projectId}.delivered.runner.jsonl`)) as any[]) {
    if (typeof v?.id === "string") ids.add(v.id)
  }
  for (const v of readJsonl(join(dir, `${projectId}.delivered.claude.jsonl`)) as any[]) {
    if (typeof v?.notice_id === "string") ids.add(v.notice_id)
  }
  return ids
}

/** Undelivered, recent notices, newest first, at most `limit`. */
export function selectPending(
  notices: Notice[],
  delivered: Set<string>,
  now: Date = new Date(),
  limit: number = MAX_CATCHUP_NOTICES,
): Notice[] {
  const cutoff = now.getTime() - CATCHUP_MAX_AGE_MS
  const seen = new Set<string>()
  const fresh: { n: Notice; t: number }[] = []
  for (const n of notices) {
    if (delivered.has(n.id) || seen.has(n.id)) continue
    seen.add(n.id)
    const t = Date.parse(n.created_at)
    if (!Number.isFinite(t) || t < cutoff) continue
    fresh.push({ n, t })
  }
  return fresh
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.n)
}

/** One line per notice; flattened and capped, the text is untrusted. */
export function formatCatchup(pending: Notice[]): string {
  const lines = pending.map((n) => {
    const flat = n.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
    return `- ${flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat}`
  })
  return [
    `Nexus Dispatch notices received while no session was running (${pending.length}, newest first):`,
    ...lines,
    "Run /nexus-dispatch-sweep to handle them.",
  ].join("\n")
}

/** Append one delivery record per notice (mode 0600). False on error. */
export function recordDelivered(
  stateDir: string,
  projectId: string,
  sessionId: string,
  pending: Notice[],
  now: Date = new Date(),
): boolean {
  if (pending.length === 0) return true
  const at = now.toISOString()
  const lines = pending
    .map((n) =>
      JSON.stringify({
        notice_id: n.id,
        session_id: sessionId,
        at,
      } satisfies ClaudeDelivery),
    )
    .join("\n")
  try {
    const dir = noticesDir(stateDir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, `${projectId}.delivered.claude.jsonl`), `${lines}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

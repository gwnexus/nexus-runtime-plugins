import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { initialObserverState, type ObserverState } from "./types.ts"

/**
 * Observer state persistence (ADR-0120). Lives next to `events.jsonl`
 * (`<agentic_root>/claude/observer/state.json`) rather than in `.nexus/` via
 * core/state-store.ts, so the whole observer footprint stays in one
 * directory. Writes go to a temp file and are renamed into place, so a
 * crashed hook never leaves a half-written file behind.
 *
 * Concurrency: Claude Code runs hooks of parallel events as separate
 * processes at the same time -- observed live for a background `Agent` spawn,
 * where `PostToolUse(Agent)` and `SubagentStart` race. Callers wrap the whole
 * load -> observe -> save -> append cycle in `withObserverLock()`.
 */

export const STATE_FILE = "state.json"

/** Entries not seen for this long are dropped on save. */
export const STATE_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_PENDING = 50

export const LOCK_FILE = "state.lock"
/** Give up waiting for the lock after this long and run without it. */
export const LOCK_WAIT_MS = 1000
/** A lock older than this is considered abandoned by a crashed hook. */
export const LOCK_STALE_MS = 2000

const sleepCell = new Int32Array(new SharedArrayBuffer(4))

/**
 * Run `fn` holding an exclusive `O_EXCL` lock file in `observerDir`. Never
 * throws for lock problems and never waits longer than `LOCK_WAIT_MS`: if the
 * lock cannot be taken, `fn` runs anyway with `locked = false`, and the caller
 * must not save state then (its load may be stale, so a save would overwrite
 * another process's update). Appending the event record is still safe.
 */
export function withObserverLock<T>(observerDir: string, fn: (locked: boolean) => T): T {
  const lockPath = join(observerDir, LOCK_FILE)
  let fd: number | null = null
  try {
    mkdirSync(observerDir, { recursive: true })
    const deadline = Date.now() + LOCK_WAIT_MS
    while (fd === null) {
      try {
        fd = openSync(lockPath, "wx")
      } catch (err: any) {
        if (err?.code !== "EEXIST") break
        if (isStale(lockPath)) {
          try {
            unlinkSync(lockPath)
          } catch {
            // another process took it over first
          }
          continue
        }
        if (Date.now() >= deadline) break
        Atomics.wait(sleepCell, 0, 0, 2)
      }
    }
  } catch {
    // unusable directory -- run unlocked
  }
  try {
    return fn(fd !== null)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
        unlinkSync(lockPath)
      } catch {
        // ignore
      }
    }
  }
}

function isStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}

export function loadObserverState(observerDir: string): ObserverState {
  try {
    const parsed = JSON.parse(readFileSync(join(observerDir, STATE_FILE), "utf-8"))
    const base = initialObserverState()
    return {
      agents: isObj(parsed?.agents) ? parsed.agents : base.agents,
      pending: Array.isArray(parsed?.pending) ? parsed.pending : base.pending,
      taskIds: isObj(parsed?.taskIds) ? parsed.taskIds : base.taskIds,
    }
  } catch {
    return initialObserverState()
  }
}

export function saveObserverState(observerDir: string, state: ObserverState, now: number = Date.now()): void {
  try {
    mkdirSync(observerDir, { recursive: true })
    const pruned = pruneState(state, now)
    const tmp = join(observerDir, `${STATE_FILE}.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(pruned))
    renameSync(tmp, join(observerDir, STATE_FILE))
  } catch {
    // state loss only degrades linking/runtimes; never block the hook
  }
}

export function pruneState(state: ObserverState, now: number): ObserverState {
  const cutoff = now - STATE_TTL_MS
  const agents: ObserverState["agents"] = {}
  for (const [id, a] of Object.entries(state.agents)) {
    if (Date.parse(a.lastSeenAt) >= cutoff) agents[id] = a
  }
  const taskIds: ObserverState["taskIds"] = {}
  for (const [taskId, agentId] of Object.entries(state.taskIds)) {
    if (agents[agentId]) taskIds[taskId] = agentId
  }
  const pending = state.pending.filter((p) => Date.parse(p.at) >= cutoff).slice(-MAX_PENDING)
  return { agents, pending, taskIds }
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

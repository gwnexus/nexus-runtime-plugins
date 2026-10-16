import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Append-only JSONL writer with single-generation size rotation.
 *
 * `events.jsonl` is rotated to `events.1.jsonl` (overwriting any previous
 * rotation, so exactly one old generation is kept) once it reaches
 * `maxBytes`. Every filesystem error is swallowed: the observer must never
 * block or fail a Claude Code hook.
 */

export const EVENTS_FILE = "events.jsonl"
export const ROTATED_FILE = "events.1.jsonl"
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export function appendRecords(
  observerDir: string,
  records: readonly object[],
  maxBytes: number = DEFAULT_MAX_BYTES,
): boolean {
  if (records.length === 0) return true
  try {
    mkdirSync(observerDir, { recursive: true })
    const path = join(observerDir, EVENTS_FILE)
    rotateIfNeeded(observerDir, path, maxBytes)
    const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n"
    appendFileSync(path, payload)
    return true
  } catch {
    return false
  }
}

function rotateIfNeeded(observerDir: string, path: string, maxBytes: number): void {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return // no file yet
  }
  if (size < maxBytes) return
  renameSync(path, join(observerDir, ROTATED_FILE))
}

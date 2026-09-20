import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Simple JSON file-based state persistence (ADR-C05 core module).
 *
 * Claude Code hooks are invoked as short-lived external processes (one per
 * hook event), unlike OpenCode plugins which run as a single long-lived
 * in-memory instance. Any adapter that needs state across hook invocations
 * (e.g. session-guard's turn counters) must persist it to disk between
 * calls. This module centralizes that pattern so each Claude Code adapter
 * doesn't reimplement its own read/write-with-fallback logic.
 */
export function loadState<T>(directory: string, fileName: string, fallback: T): T {
  try {
    const path = join(directory, ".nexus", fileName)
    if (!existsSync(path)) return fallback
    const raw = readFileSync(path, "utf-8")
    return { ...fallback, ...JSON.parse(raw) } as T
  } catch {
    return fallback
  }
}

export function saveState<T>(directory: string, fileName: string, state: T): void {
  try {
    const dir = join(directory, ".nexus")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, fileName), JSON.stringify(state, null, 2))
  } catch {
    // Silently ignore file write errors — state loss just resets counters,
    // it does not crash the hook or block the tool call.
  }
}

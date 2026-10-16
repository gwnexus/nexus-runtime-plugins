import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Shared file-based logger factory (core module).
 *
 * Every Nexus runtime plugin writes debug logs to `.nexus/<name>.log` inside
 * the project directory. This was previously reimplemented per-plugin; it is
 * now a single core module shared by both the OpenCode and Claude Code
 * adapters.
 *
 * Logs are size-rotated: once a file reaches `maxBytes` it is renamed to
 * `<name>.1` (overwriting the previous rotation, so one old generation is
 * kept) and a new file is started. The size is checked on the first write of
 * the process and then every `CHECK_EVERY_WRITES` writes, which covers both
 * short-lived hook processes and long-running OpenCode plugins.
 *
 * Usage:
 *   const log = createFileLogger(directory, "session-guard.log")
 *   log("info", "Plugin initializing")
 */
export type FileLogger = (level: string, message: string) => void

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024
export const CHECK_EVERY_WRITES = 200

export function createFileLogger(
  directory: string,
  logFileName: string,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): FileLogger {
  let logDir: string | null = null
  let writes = 0

  return (level: string, message: string): void => {
    try {
      if (!logDir) {
        logDir = join(directory, ".nexus")
        mkdirSync(logDir, { recursive: true })
      }
      const path = join(logDir, logFileName)
      if (writes++ % CHECK_EVERY_WRITES === 0) rotateIfNeeded(path, maxBytes)
      const ts = new Date().toISOString()
      const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}\n`
      appendFileSync(path, line)
    } catch {
      // Silently ignore file write errors
    }
  }
}

function rotateIfNeeded(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`)
  } catch {
    // No file yet, or rotation failed: keep appending to the current file
  }
}

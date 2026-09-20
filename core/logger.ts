import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Shared file-based logger factory (ADR-C05 core module).
 *
 * Every Nexus runtime plugin writes debug logs to `.nexus/<name>.log` inside
 * the project directory. This was previously reimplemented per-plugin; it is
 * now a single core module shared by both the OpenCode and Claude Code
 * adapters.
 *
 * Usage:
 *   const log = createFileLogger(directory, "session-guard.log")
 *   log("info", "Plugin initializing")
 */
export type FileLogger = (level: string, message: string) => void

export function createFileLogger(directory: string, logFileName: string): FileLogger {
  let logDir: string | null = null

  return (level: string, message: string): void => {
    try {
      if (!logDir) {
        logDir = join(directory, ".nexus")
        mkdirSync(logDir, { recursive: true })
      }
      const ts = new Date().toISOString()
      const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}\n`
      appendFileSync(join(logDir, logFileName), line)
    } catch {
      // Silently ignore file write errors
    }
  }
}

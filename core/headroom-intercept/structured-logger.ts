import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, statSync, chmodSync } from "node:fs"
import { join } from "node:path"

/**
 * Structured JSONL logger (ADR-C05 core module) — runtime-agnostic.
 * Writes rotated, permission-locked JSONL debug/audit logs to
 * `.nexus/headroom-intercept.jsonl`. Identical behavior to the original
 * plugin's StructuredLogger; only the module boundary moved.
 */

const LOG_MAX_BYTES = 10 * 1024 * 1024 // 10 MB per log file
const LOG_RETAINED_FILES = 3

export class StructuredLogger {
  private logFile: string
  private logDir: string
  private serviceName: string
  private serviceVersion: string
  private debugEnabled: boolean

  constructor(projectDir: string, serviceName: string, serviceVersion: string, debugEnabled: boolean) {
    this.logDir = join(projectDir, ".nexus")
    this.logFile = join(this.logDir, "headroom-intercept.jsonl")
    this.serviceName = serviceName
    this.serviceVersion = serviceVersion
    this.debugEnabled = debugEnabled
  }

  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
    try {
      mkdirSync(this.logDir, { recursive: true })
      this.rotateIfNeeded()
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        service: this.serviceName,
        v: this.serviceVersion,
        level,
        event,
        ...fields,
      })
      appendFileSync(this.logFile, entry + "\n")
      try {
        chmodSync(this.logFile, 0o600)
      } catch {}
    } catch {
      // Silent — logging must never break the plugin
    }
  }

  /** Verbose trace — only written when debugEnabled=true. */
  debug(event: string, fields: Record<string, unknown> = {}): void {
    if (!this.debugEnabled) return
    this.log("info", `debug:${event}`, { debug: true, ...fields })
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logFile)) return
      const size = statSync(this.logFile).size
      if (size < LOG_MAX_BYTES) return

      for (let i = LOG_RETAINED_FILES - 1; i >= 1; i--) {
        const older = `${this.logFile}.${i}`
        const newer = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`
        try {
          if (existsSync(newer)) writeFileSync(older, readFileSync(newer))
        } catch {}
      }
      writeFileSync(this.logFile, "")
    } catch {}
  }
}

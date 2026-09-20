import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  chmodSync,
  renameSync,
} from "node:fs"
import { join } from "node:path"
import { contentHash, estimateTokens } from "./compression.ts"

/**
 * Disk-backed original-content cache (ADR-C05 core module) — runtime-agnostic.
 * TTL eviction, quota, permissions, .gitignore, project-namespacing, atomic
 * writes. Unchanged behavior from the original plugin during the ADR-C05
 * core extraction; only the module boundary moved.
 */

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
export const CACHE_MAX_BYTES = 100 * 1024 * 1024 // 100 MB
export const CACHE_MAX_ENTRIES = 200

export class OriginalStore {
  private cache = new Map<string, { content: string; storedAt: number }>()
  private cacheDir: string
  private projectDir: string
  onIntegrityFailure?: (hash: string) => void
  onCacheReadFailed?: (hash: string, reason: string) => void

  /**
   * @param projectDir  Root of the project (ctx.directory / hook cwd)
   * @param projectId   Nexus project UUID — namespaces cache entries so
   *                    multiple projects on the same machine never share
   *                    cache state. Falls back to "unknown" when unavailable.
   */
  constructor(projectDir: string, projectId: string | null) {
    this.projectDir = projectDir
    const ns = projectId ?? "unknown"
    this.cacheDir = join(projectDir, ".nexus", "headroom-cache", ns)
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      chmodSync(this.cacheDir, 0o700)
      try {
        chmodSync(join(projectDir, ".nexus", "headroom-cache"), 0o700)
      } catch {}
      this.ensureGitignore()
    } catch {}
  }

  private ensureGitignore(): void {
    try {
      const gi = join(this.projectDir, ".nexus", ".gitignore")
      if (!existsSync(gi)) {
        writeFileSync(gi, "headroom-cache/\nheadroom-intercept.jsonl*\n")
        chmodSync(gi, 0o644)
      } else {
        const content = readFileSync(gi, "utf-8")
        const lines: string[] = []
        if (!content.includes("headroom-cache/")) lines.push("headroom-cache/")
        if (!content.includes("headroom-intercept.jsonl")) lines.push("headroom-intercept.jsonl*")
        if (lines.length > 0) writeFileSync(gi, content + "\n" + lines.join("\n") + "\n")
      }
    } catch {}
  }

  set(hash: string, content: string): void {
    this.cache.set(hash, { content, storedAt: Date.now() })
    try {
      const filePath = join(this.cacheDir, `${hash}.json`)
      const unique = `${hash}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      const tmpPath = join(this.cacheDir, unique)
      writeFileSync(
        tmpPath,
        JSON.stringify({
          hash,
          length: content.length,
          estimatedTokens: estimateTokens(content),
          storedAt: new Date().toISOString(),
          content,
        }),
      )
      chmodSync(tmpPath, 0o600)
      renameSync(tmpPath, filePath)
    } catch {
      try {
        const dir = this.cacheDir
        try {
          for (const f of readdirSync(dir).filter(
            (f) => f.startsWith(`${hash}.${process.pid}`) && f.endsWith(".tmp"),
          )) {
            try {
              unlinkSync(join(dir, f))
            } catch {}
          }
        } catch {}
      } catch {}
    }
  }

  get(hash: string): string | null {
    const cached = this.cache.get(hash)
    if (cached !== undefined) {
      if (Date.now() - cached.storedAt > CACHE_TTL_MS) {
        this.cache.delete(hash)
        this.deleteDiskEntry(hash)
        return null
      }
      return cached.content
    }
    try {
      const filePath = join(this.cacheDir, `${hash}.json`)
      if (!existsSync(filePath)) return null
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(filePath)
      } catch {
        this.onCacheReadFailed?.(hash, "stat_failed")
        return null
      }
      if (Date.now() - st.mtimeMs > CACHE_TTL_MS) {
        this.deleteDiskEntry(hash)
        return null
      }
      let raw: string
      try {
        raw = readFileSync(filePath, "utf-8")
      } catch {
        this.onCacheReadFailed?.(hash, "read_failed")
        return null
      }
      let data: any
      try {
        data = JSON.parse(raw)
      } catch {
        this.deleteDiskEntry(hash)
        this.onCacheReadFailed?.(hash, "parse_failed")
        return null
      }

      if (
        !data?.content ||
        typeof data.content !== "string" ||
        data.hash !== hash ||
        contentHash(data.content) !== hash
      ) {
        this.deleteDiskEntry(hash)
        this.onIntegrityFailure?.(hash)
        return null
      }

      const persistedAt = typeof data.storedAt === "string" ? Date.parse(data.storedAt) : st.mtimeMs
      const rawStoredAt = Number.isFinite(persistedAt) ? persistedAt : st.mtimeMs
      const safeStoredAt = Math.min(rawStoredAt, st.mtimeMs, Date.now())

      if (Date.now() - safeStoredAt > CACHE_TTL_MS) {
        this.deleteDiskEntry(hash)
        return null
      }

      this.cache.set(hash, { content: data.content, storedAt: safeStoredAt })
      return data.content
    } catch {}
    return null
  }

  private deleteDiskEntry(hash: string): void {
    try {
      unlinkSync(join(this.cacheDir, `${hash}.json`))
    } catch {}
  }

  /** Prune in-memory cache (FIFO, max 50 entries). */
  prune(maxEntries = 50): void {
    if (this.cache.size <= maxEntries) return
    const keys = Array.from(this.cache.keys())
    const sorted = keys.sort((a, b) => {
      const ta = this.cache.get(a)?.storedAt ?? 0
      const tb = this.cache.get(b)?.storedAt ?? 0
      return ta - tb
    })
    for (const key of sorted.slice(0, keys.length - maxEntries)) {
      this.cache.delete(key)
    }
  }

  /** Evict disk entries — three-phase: expire -> count-trim -> byte-trim from oldest end. */
  evictDisk(): void {
    try {
      const allFiles = readdirSync(this.cacheDir)
      for (const f of allFiles.filter((f) => f.endsWith(".tmp"))) {
        try {
          unlinkSync(join(this.cacheDir, f))
        } catch {}
      }

      const files = allFiles.filter((f) => f.endsWith(".json"))
      const now = Date.now()
      const entries: { file: string; mtime: number; size: number }[] = []

      for (const f of files) {
        try {
          const fp = join(this.cacheDir, f)
          const st = statSync(fp)
          entries.push({ file: fp, mtime: st.mtimeMs, size: st.size })
        } catch {}
      }

      const alive = entries.filter((entry) => {
        if (now - entry.mtime > CACHE_TTL_MS) {
          try {
            unlinkSync(entry.file)
          } catch {}
          return false
        }
        return true
      })

      alive.sort((a, b) => b.mtime - a.mtime)
      const afterCount = alive.filter((entry, idx) => {
        if (idx >= CACHE_MAX_ENTRIES) {
          try {
            unlinkSync(entry.file)
          } catch {}
          return false
        }
        return true
      })

      let totalBytes = afterCount.reduce((sum, e) => sum + e.size, 0)
      if (totalBytes > CACHE_MAX_BYTES) {
        for (const entry of [...afterCount].reverse()) {
          if (totalBytes <= CACHE_MAX_BYTES) break
          try {
            unlinkSync(entry.file)
            totalBytes -= entry.size
          } catch {}
        }
      }
    } catch {}
  }
}

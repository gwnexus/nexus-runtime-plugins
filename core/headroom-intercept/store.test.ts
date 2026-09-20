import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock fs so the store never touches the real filesystem.
const files = new Map<string, string>()
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    existsSync: vi.fn((p: string) => files.has(String(p))),
    writeFileSync: vi.fn((p: string, content: string) => {
      files.set(String(p), content)
    }),
    readFileSync: vi.fn((p: string) => {
      const v = files.get(String(p))
      if (v === undefined) throw new Error("ENOENT")
      return v
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const v = files.get(String(from))
      if (v !== undefined) {
        files.set(String(to), v)
        files.delete(String(from))
      }
    }),
    unlinkSync: vi.fn((p: string) => {
      files.delete(String(p))
    }),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: Date.now() })),
  }
})

import { OriginalStore } from "./store.ts"

describe("headroom-intercept core OriginalStore", () => {
  beforeEach(() => {
    files.clear()
  })

  it("stores and retrieves content by hash via in-memory cache", () => {
    const store = new OriginalStore("/tmp/test-project", "proj-1")
    store.set("hash1", "original content")
    expect(store.get("hash1")).toBe("original content")
  })

  it("returns null for an unknown hash", () => {
    const store = new OriginalStore("/tmp/test-project", "proj-1")
    expect(store.get("nonexistent")).toBeNull()
  })

  it("prune() keeps only the most recent maxEntries", () => {
    const store = new OriginalStore("/tmp/test-project", "proj-1")
    for (let i = 0; i < 5; i++) store.set(`hash-${i}`, `content-${i}`)
    store.prune(2)
    // Oldest entries should be gone from the in-memory cache (disk read will fail too, mocked ENOENT)
    expect(store.get("hash-0")).toBeNull()
    expect(store.get("hash-4")).toBe("content-4")
  })
})

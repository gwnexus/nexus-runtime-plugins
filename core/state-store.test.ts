import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadState, saveState } from "./state-store.ts"

describe("state-store (real fs, no mocks)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nx-state-store-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns the fallback when no state file exists", () => {
    expect(loadState(dir, "missing.json", { count: 0 })).toEqual({ count: 0 })
  })

  it("round-trips an object state, merged with fallback for missing keys", () => {
    saveState(dir, "obj.json", { count: 1, name: "a" })
    const loaded = loadState(dir, "obj.json", { count: 0, name: "", extra: true })
    expect(loaded).toEqual({ count: 1, name: "a", extra: true })
  })

  it("round-trips a bare string state without corrupting it (Fix, Dispatch 0e38cf7b review)", () => {
    saveState(dir, "session-id.json", "s-1")
    const loaded = loadState<string | null>(dir, "session-id.json", null)
    expect(loaded).toBe("s-1")
  })

  it("distinguishes a changed bare-string state across saves (session_id reset detection)", () => {
    saveState(dir, "session-id.json", "s-1")
    expect(loadState<string | null>(dir, "session-id.json", null)).toBe("s-1")
    saveState(dir, "session-id.json", "s-2")
    expect(loadState<string | null>(dir, "session-id.json", null)).toBe("s-2")
  })

  it("round-trips a null state", () => {
    saveState<string | null>(dir, "null.json", null)
    expect(loadState<string | null>(dir, "null.json", "fallback")).toBeNull()
  })

  it("round-trips an array state without object-spread corruption", () => {
    saveState(dir, "arr.json", [1, 2, 3])
    expect(loadState<number[]>(dir, "arr.json", [])).toEqual([1, 2, 3])
  })

  it("returns fallback on corrupt JSON", () => {
    saveState(dir, "will-corrupt.json", { ok: true })
    // Overwrite with invalid JSON directly.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs")
    writeFileSync(join(dir, ".nexus", "will-corrupt.json"), "{not valid json")
    expect(loadState(dir, "will-corrupt.json", { ok: false })).toEqual({ ok: false })
  })
})

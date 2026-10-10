import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileLogger, CHECK_EVERY_WRITES } from "./logger.ts"

describe("createFileLogger rotation", () => {
  let root: string
  let logPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nx-logger-"))
    logPath = join(root, ".nexus", "test.log")
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("appends without rotating below the limit", () => {
    const log = createFileLogger(root, "test.log", 1024)
    log("info", "one")
    log("info", "two")
    expect(readFileSync(logPath, "utf8")).toMatch(/one\n.*two\n$/)
    expect(existsSync(`${logPath}.1`)).toBe(false)
  })

  it("rotates an oversized file on the first write of a process", () => {
    mkdirSync(join(root, ".nexus"))
    writeFileSync(logPath, "x".repeat(2048))
    createFileLogger(root, "test.log", 1024)("info", "fresh")
    expect(statSync(`${logPath}.1`).size).toBe(2048)
    expect(readFileSync(logPath, "utf8")).toMatch(/\[INFO \] fresh\n$/)
  })

  it("keeps one generation, overwriting the previous rotation", () => {
    mkdirSync(join(root, ".nexus"))
    writeFileSync(`${logPath}.1`, "old generation")
    writeFileSync(logPath, "y".repeat(2048))
    createFileLogger(root, "test.log", 1024)("info", "fresh")
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("y".repeat(2048))
    expect(existsSync(`${logPath}.2`)).toBe(false)
  })

  it("rechecks the size in long-running processes", () => {
    const log = createFileLogger(root, "test.log", 1024)
    const msg = "z".repeat(100)
    for (let i = 0; i <= CHECK_EVERY_WRITES; i++) log("info", msg)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(statSync(logPath).size).toBeLessThan(1024)
  })

  it("never throws when the directory cannot be created", () => {
    writeFileSync(join(root, ".nexus"), "not a directory")
    expect(() => createFileLogger(root, "test.log")("info", "x")).not.toThrow()
  })
})

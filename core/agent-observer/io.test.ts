import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  appendFileSync,
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveRepoInfo } from "./git.ts"
import { readUsageIncrement } from "./transcript.ts"
import { appendRecords, EVENTS_FILE, ROTATED_FILE } from "./writer.ts"
import {
  LOCK_FILE,
  LOCK_STALE_MS,
  loadObserverState,
  pruneState,
  saveObserverState,
  STATE_TTL_MS,
  withObserverLock,
} from "./state.ts"
import { initialObserverState } from "./types.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-observer-core-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("resolveRepoInfo", () => {
  it("returns the top-level basename for a normal checkout", () => {
    mkdirSync(join(dir, "myrepo/.git"), { recursive: true })
    mkdirSync(join(dir, "myrepo/src/deep"), { recursive: true })
    expect(resolveRepoInfo(join(dir, "myrepo/src/deep"))).toEqual({
      repository: "myrepo",
      worktree: null,
    })
  })

  it("detects a linked worktree and reports the main repository name", () => {
    mkdirSync(join(dir, "myrepo/.git/worktrees/feat"), { recursive: true })
    mkdirSync(join(dir, "wt-feat/src"), { recursive: true })
    writeFileSync(join(dir, "wt-feat/.git"), `gitdir: ${join(dir, "myrepo/.git/worktrees/feat")}\n`)
    expect(resolveRepoInfo(join(dir, "wt-feat/src"))).toEqual({
      repository: "myrepo",
      worktree: join(dir, "wt-feat"),
    })
  })

  it("treats a submodule .git file as a plain checkout", () => {
    mkdirSync(join(dir, "sub"), { recursive: true })
    writeFileSync(join(dir, "sub/.git"), "gitdir: ../parent/.git/modules/sub\n")
    expect(resolveRepoInfo(join(dir, "sub"))).toEqual({
      repository: "sub",
      worktree: null,
    })
  })

  it("returns nulls outside a repository or without cwd", () => {
    expect(resolveRepoInfo(null)).toEqual({ repository: null, worktree: null })
  })
})

describe("readUsageIncrement", () => {
  const line = (id: string, input: number, output: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "assistant",
      ...extra,
      message: {
        id,
        model: "claude-opus-5-5",
        usage: {
          input_tokens: input,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: output,
        },
      },
    }) + "\n"

  it("reads incrementally and counts a streamed message id once (last line wins)", () => {
    const t = join(dir, "t.jsonl")
    writeFileSync(
      t,
      line("m1", 1, 5) + JSON.stringify({ type: "user", message: { content: "x" } }) + "\n" + line("m2", 2, 3),
    )
    const first = readUsageIncrement(t, null)
    expect(first.cursor).toMatchObject({
      inputTokens: 101 + 102,
      outputTokens: 8,
      lastMessageId: "m2",
    })
    expect(first.model).toBe("claude-opus-5-5")

    appendFileSync(t, line("m2", 2, 40) + line("m3", 0, 1))
    const second = readUsageIncrement(t, first.cursor)
    expect(second.cursor).toMatchObject({
      inputTokens: 101 + 102 + 100,
      outputTokens: 5 + 40 + 1,
    })

    const third = readUsageIncrement(t, second.cursor)
    expect(third.cursor).toEqual(second.cursor)
    expect(third.model).toBeNull()
  })

  it("ignores an incomplete trailing line until it is terminated", () => {
    const t = join(dir, "t.jsonl")
    writeFileSync(t, line("m1", 1, 1) + line("m2", 1, 1).trimEnd())
    const a = readUsageIncrement(t, null)
    expect(a.cursor.outputTokens).toBe(1)
    appendFileSync(t, "\n")
    expect(readUsageIncrement(t, a.cursor).cursor.outputTokens).toBe(2)
  })

  it("skips sidechain lines when asked", () => {
    const t = join(dir, "t.jsonl")
    writeFileSync(t, line("m1", 0, 1) + line("s1", 0, 7, { isSidechain: true }))
    expect(readUsageIncrement(t, null, { skipSidechain: true }).cursor.outputTokens).toBe(1)
  })

  it("keeps the previous cursor when the transcript is missing", () => {
    const prev = readUsageIncrement(join(dir, "missing.jsonl"), null).cursor
    expect(prev).toMatchObject({ offset: 0, inputTokens: 0 })
  })
})

describe("appendRecords", () => {
  it("rotates events.jsonl to events.1.jsonl at the size limit, keeping one generation", () => {
    const obs = join(dir, "observer")
    appendRecords(obs, [{ n: 1, pad: "x".repeat(60) }], 50)
    appendRecords(obs, [{ n: 2 }], 50)
    expect(readFileSync(join(obs, ROTATED_FILE), "utf-8")).toContain('"n":1')
    expect(readFileSync(join(obs, EVENTS_FILE), "utf-8")).toBe('{"n":2}\n')
    appendRecords(obs, [{ n: 3, pad: "x".repeat(60) }], 50)
    appendRecords(obs, [{ n: 4 }], 50)
    expect(readFileSync(join(obs, ROTATED_FILE), "utf-8")).not.toContain('"n":1')
  })

  it("swallows filesystem errors", () => {
    writeFileSync(join(dir, "file"), "")
    expect(appendRecords(join(dir, "file", "observer"), [{ a: 1 }])).toBe(false)
  })
})

describe("observer state", () => {
  it("round-trips and prunes stale agents, orphaned task ids and old pending spawns", () => {
    const now = Date.parse("2026-09-26T12:00:00Z")
    const old = new Date(now - STATE_TTL_MS - 1).toISOString()
    const fresh = new Date(now).toISOString()
    const agent = (lastSeenAt: string) => ({
      role: "main" as const,
      parentAgentId: null,
      startedAt: lastSeenAt,
      lastSeenAt,
      task: null,
      model: null,
      toolUseId: null,
      state: "unknown" as const,
      usage: null,
    })
    const state = initialObserverState()
    state.agents = { keep: agent(fresh), drop: agent(old) }
    state.taskIds = { t1: "keep", t2: "drop" }
    state.pending = [
      {
        toolUseId: "p",
        parentAgentId: "keep",
        subagentType: null,
        task: null,
        at: old,
      },
    ]
    expect(pruneState(state, now)).toEqual({
      agents: { keep: agent(fresh) },
      taskIds: { t1: "keep" },
      pending: [],
    })

    saveObserverState(dir, state, now)
    expect(Object.keys(loadObserverState(dir).agents)).toEqual(["keep"])
  })

  it("falls back to an empty state on a corrupt file", () => {
    writeFileSync(join(dir, "state.json"), "{not json")
    expect(loadObserverState(dir)).toEqual(initialObserverState())
    expect(existsSync(join(dir, "state.json"))).toBe(true)
  })
})

describe("withObserverLock", () => {
  it("holds the lock during fn and releases it afterwards, even on throw", () => {
    expect(withObserverLock(dir, () => existsSync(join(dir, LOCK_FILE)))).toBe(true)
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
    expect(() =>
      withObserverLock(dir, () => {
        throw new Error("x")
      }),
    ).toThrow("x")
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
  })

  it("takes over a stale lock", () => {
    writeFileSync(join(dir, LOCK_FILE), "")
    const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000
    utimesSync(join(dir, LOCK_FILE), old, old)
    expect(withObserverLock(dir, () => 42)).toBe(42)
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
  })

  it("runs unlocked after the wait budget when a fresh lock is held", () => {
    writeFileSync(join(dir, LOCK_FILE), "")
    const start = Date.now()
    expect(withObserverLock(dir, () => "ran")).toBe("ran")
    expect(Date.now() - start).toBeLessThan(500)
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true) // foreign lock left untouched
  })
})

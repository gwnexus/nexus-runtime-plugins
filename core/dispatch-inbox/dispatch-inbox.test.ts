import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchStateDir, isSafeId } from "./types.ts"
import { buildSessionFile, removeSessionFile, sessionFilePath, writeSessionFile } from "./sessions.ts"
import {
  CATCHUP_MAX_AGE_MS,
  formatCatchup,
  readDeliveredIds,
  readNotices,
  recordDelivered,
  selectPending,
} from "./notices.ts"

const P = "6b45a172-3d5b-444a-b49f-5127ff7891e6"
const NOW = new Date("2026-11-08T12:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

let state: string
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "nx-dispatch-"))
})
afterEach(() => rmSync(state, { recursive: true, force: true }))

function notice(id: string, createdAt: string, text = `Nexus: new Dispatch ${id}. Run /nexus-dispatch-sweep.`) {
  return {
    id,
    project_id: P,
    dispatch_id: `d-${id}`,
    event_id: 1,
    kind: "incoming",
    mode: "notify",
    text,
    created_at: createdAt,
  }
}
function writeLines(name: string, rows: unknown[]) {
  mkdirSync(join(state, "notices"), { recursive: true })
  writeFileSync(
    join(state, "notices", name),
    rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n",
  )
}

describe("dispatchStateDir", () => {
  it("defaults to ~/.config/nexus/state/dispatch, override wins", () => {
    expect(dispatchStateDir({ HOME: "/h" })).toBe(join("/h", ".config", "nexus", "state", "dispatch"))
    expect(dispatchStateDir({ HOME: "/h", NEXUS_DISPATCH_STATE_DIR: "/x" })).toBe("/x")
    expect(dispatchStateDir({})).toBeNull()
  })

  it("accepts only file-name-safe ids", () => {
    expect(isSafeId("a5392d42-c5dc-44a2-b956-fce20388bab2")).toBe(true)
    for (const bad of ["", "../x", "a/b", ".hidden", "a..b", 42, undefined]) expect(isSafeId(bad)).toBe(false)
  })
})

describe("session file", () => {
  const env = {
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret-token",
  }

  it("is built only when socket, token and a safe session id are present", () => {
    expect(buildSessionFile("s1", "/repo", env, NOW)).toEqual({
      session_id: "s1",
      cwd: "/repo",
      socket: "/tmp/s.sock",
      token: "secret-token",
      started_at: NOW.toISOString(),
    })
    expect(
      buildSessionFile("s1", "/repo", {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock",
      }),
    ).toBeNull()
    expect(buildSessionFile("s1", "/repo", { CLAUDE_CODE_MESSAGING_TOKEN: "t" })).toBeNull()
    expect(buildSessionFile("../evil", "/repo", env)).toBeNull()
  })

  it("is written atomically with mode 0600 in a 0700 directory and removed again", () => {
    const file = buildSessionFile("s1", "/repo", env, NOW)!
    expect(writeSessionFile(state, file)).toBe(true)
    const path = sessionFilePath(state, "s1")
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(file)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(state, "sessions")).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(state, "sessions"))).toEqual(["s1.json"])
    expect(removeSessionFile(state, "s1")).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(removeSessionFile(state, "s1")).toBe(false)
    expect(removeSessionFile(state, "../x")).toBe(false)
  })

  it("overwrites the file of a resumed session", () => {
    writeSessionFile(state, buildSessionFile("s1", "/a", env, NOW)!)
    writeSessionFile(state, buildSessionFile("s1", "/b", env, NOW)!)
    expect(JSON.parse(readFileSync(sessionFilePath(state, "s1"), "utf-8")).cwd).toBe("/b")
  })
})

describe("notice catch-up", () => {
  it("reads the queue and skips malformed lines", () => {
    writeLines(`${P}.jsonl`, [notice("n1", ago(1000)), "{torn", { id: "x" }, notice("n2", ago(500))])
    expect(readNotices(state, P).map((n) => n.id)).toEqual(["n1", "n2"])
    expect(readNotices(state, "other")).toEqual([])
  })

  it("treats ids from either delivery file as delivered", () => {
    writeLines(`${P}.delivered.runner.jsonl`, [{ id: "n1", session_id: "s", via: "inbox", at: ago(0) }])
    writeLines(`${P}.delivered.claude.jsonl`, [{ notice_id: "n2", session_id: "s", at: ago(0) }])
    expect([...readDeliveredIds(state, P)].sort()).toEqual(["n1", "n2"])
  })

  it("selects undelivered recent notices, newest first, capped, deduplicated", () => {
    const notices = [
      notice("old", ago(CATCHUP_MAX_AGE_MS + 1)),
      notice("n1", ago(3000)),
      notice("n2", ago(1000)),
      notice("n2", ago(1000)),
      notice("done", ago(500)),
      notice("bad-date", "yesterday"),
      notice("n3", ago(2000)),
    ]
    expect(selectPending(notices, new Set(["done"]), NOW).map((n) => n.id)).toEqual(["n2", "n3", "n1"])
    expect(selectPending(notices, new Set(), NOW, 2).map((n) => n.id)).toEqual(["done", "n2"])
  })

  it("records deliveries append-only with mode 0600", () => {
    expect(recordDelivered(state, P, "s1", [notice("n1", ago(0))], NOW)).toBe(true)
    expect(recordDelivered(state, P, "s2", [notice("n2", ago(0))], NOW)).toBe(true)
    const path = join(state, "notices", `${P}.delivered.claude.jsonl`)
    const rows = readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(rows).toEqual([
      { notice_id: "n1", session_id: "s1", at: NOW.toISOString() },
      { notice_id: "n2", session_id: "s2", at: NOW.toISOString() },
    ])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect([...readDeliveredIds(state, P)].sort()).toEqual(["n1", "n2"])
  })

  it("formats one flattened, capped line per notice", () => {
    const text = formatCatchup([notice("a", ago(0), "line1\nline2"), notice("b", ago(0), "x".repeat(400))])
    const lines = text.split("\n")
    expect(lines[0]).toMatch(/\(2, newest first\)/)
    expect(lines[1]).toBe("- line1 line2")
    expect(lines[2].length).toBeLessThanOrEqual(302)
    expect(lines.at(-1)).toBe("Run /nexus-dispatch-sweep to handle them.")
  })
})

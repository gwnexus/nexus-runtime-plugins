import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  handleSessionEnd,
  handleSessionStart,
  isDispatchInboxEnabled,
  readProjectIdFromConfigToml,
  resolveProjectId,
} from "./nexus-dispatch-inbox.ts"

const P = "6b45a172-3d5b-444a-b49f-5127ff7891e6"
const SESSION = "a5392d42-c5dc-44a2-b956-fce20388bab2"
const TOKEN = "tok-do-not-leak-1234"
const BUNDLE = join(import.meta.dirname, "../../../plugins/nexus-core/hooks/dispatch-inbox.mjs")

let root: string
let project: string
let state: string
let logs: string[]
const log = (level: string, message: string) => logs.push(`${level} ${message}`)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nx-inbox-"))
  project = join(root, "repo")
  state = join(root, "home", ".config", "nexus", "state", "dispatch")
  mkdirSync(join(project, ".nexus"), { recursive: true })
  writeFileSync(
    join(project, ".nexus", "config.toml"),
    `[project]\nid = "${P}"\nname = "x"\n\n[project.run_target]\nid = "nope"\n`,
  )
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: join(root, "home"),
    CLAUDE_CODE_MESSAGING_SOCKET: join(root, "inbox.sock"),
    CLAUDE_CODE_MESSAGING_TOKEN: TOKEN,
    ...extra,
  }
}
function queue(rows: { id: string; created_at: string; text?: string }[]) {
  mkdirSync(join(state, "notices"), { recursive: true })
  writeFileSync(
    join(state, "notices", `${P}.jsonl`),
    rows
      .map((r) =>
        JSON.stringify({
          project_id: P,
          text: `Nexus: new Dispatch ${r.id}.`,
          ...r,
        }),
      )
      .join("\n") + "\n",
  )
}
const recent = (s: number) => new Date(Date.now() - s * 1000).toISOString()

describe("project id resolution", () => {
  it("reads [project] id from config.toml, not a nested table", () => {
    expect(readProjectIdFromConfigToml(project)).toBe(P)
    writeFileSync(join(project, ".nexus", "config.toml"), `[project.run_target]\nid = "nope"\n`)
    expect(readProjectIdFromConfigToml(project)).toBeNull()
  })

  it("prefers NEXUS_PROJECT_ID and rejects unsafe ids", () => {
    expect(resolveProjectId(project, { NEXUS_PROJECT_ID: "p-env" })).toBe("p-env")
    expect(resolveProjectId(project, {})).toBe(P)
    expect(resolveProjectId(project, { NEXUS_PROJECT_ID: "../x" })).toBeNull()
  })

  it("can be switched off", () => {
    expect(isDispatchInboxEnabled({})).toBe(true)
    expect(isDispatchInboxEnabled({ NEXUS_DISPATCH_INBOX: "off" })).toBe(false)
  })
})

describe("SessionStart / SessionEnd", () => {
  it("registers the session and removes it on SessionEnd", () => {
    expect(handleSessionStart({ session_id: SESSION }, project, log, env())).toBeNull()
    const path = join(state, "sessions", `${SESSION}.json`)
    const file = JSON.parse(readFileSync(path, "utf-8"))
    expect(file).toMatchObject({
      session_id: SESSION,
      cwd: project,
      socket: join(root, "inbox.sock"),
      token: TOKEN,
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    handleSessionEnd({ session_id: SESSION }, log, env())
    expect(existsSync(path)).toBe(false)
  })

  it("does not register without messaging variables, but still catches up", () => {
    queue([{ id: "n1", created_at: recent(10) }])
    const out = handleSessionStart({ session_id: SESSION }, project, log, {
      HOME: join(root, "home"),
    })
    expect(existsSync(join(state, "sessions"))).toBe(false)
    expect((out as any).hookSpecificOutput.additionalContext).toContain("n1")
  })

  it("delivers a queued notice exactly once, honouring runner deliveries", () => {
    queue([
      { id: "n1", created_at: recent(30) },
      { id: "n2", created_at: recent(20) },
      { id: "n3", created_at: recent(10) },
    ])
    writeFileSync(
      join(state, "notices", `${P}.delivered.runner.jsonl`),
      JSON.stringify({
        id: "n2",
        session_id: "other",
        via: "inbox",
        at: recent(5),
      }) + "\n",
    )
    const first = handleSessionStart({ session_id: SESSION }, project, log, env()) as any
    expect(first.hookSpecificOutput.hookEventName).toBe("SessionStart")
    const ctx: string = first.hookSpecificOutput.additionalContext
    expect(ctx.split("\n").slice(1, 3)).toEqual(["- Nexus: new Dispatch n3.", "- Nexus: new Dispatch n1."])
    expect(ctx).not.toContain("n2")
    expect(handleSessionStart({ session_id: "next-session" }, project, log, env())).toBeNull()
    const delivered = readFileSync(join(state, "notices", `${P}.delivered.claude.jsonl`), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(delivered.map((d) => [d.notice_id, d.session_id])).toEqual([
      ["n3", SESSION],
      ["n1", SESSION],
    ])
  })

  it("skips catch-up without a project id", () => {
    rmSync(join(project, ".nexus", "config.toml"))
    queue([{ id: "n1", created_at: recent(10) }])
    expect(handleSessionStart({ session_id: SESSION }, project, log, env())).toBeNull()
  })

  it("never logs the token", () => {
    queue([{ id: "n1", created_at: recent(10) }])
    handleSessionStart({ session_id: SESSION }, project, log, env())
    handleSessionEnd({ session_id: SESSION }, log, env())
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join("\n")).not.toContain(TOKEN)
  })
})

describe("built bundle (plugins/nexus-core/hooks/dispatch-inbox.mjs)", () => {
  function run(mode: string, extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [BUNDLE, mode], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        ...env(),
        CLAUDE_PROJECT_DIR: project,
        ...extraEnv,
      },
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: SESSION,
        cwd: project,
        source: "startup",
      }),
      encoding: "utf-8",
    })
  }

  it("registers, catches up, unregisters, and keeps the token out of every other file", () => {
    queue([{ id: "n1", created_at: recent(10) }])
    const start = run("session-start")
    expect(start.status).toBe(0)
    expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toContain("Nexus: new Dispatch n1.")
    expect(start.stdout).not.toContain(TOKEN)
    const sessionFile = join(state, "sessions", `${SESSION}.json`)
    expect(statSync(sessionFile).mode & 0o777).toBe(0o600)

    const end = run("session-end")
    expect(end.status).toBe(0)
    expect(end.stdout).toBe("")
    expect(existsSync(sessionFile)).toBe(false)

    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      )
    const all = [...files(project), ...files(state)]
    expect(all.some((f) => f.endsWith("dispatch-inbox.log"))).toBe(true)
    for (const f of all) expect(readFileSync(f, "utf-8"), f).not.toContain(TOKEN)
  })

  it("does nothing when disabled", () => {
    queue([{ id: "n1", created_at: recent(10) }])
    const res = run("session-start", { NEXUS_DISPATCH_INBOX: "off" })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe("")
    expect(existsSync(join(state, "sessions"))).toBe(false)
  })
})

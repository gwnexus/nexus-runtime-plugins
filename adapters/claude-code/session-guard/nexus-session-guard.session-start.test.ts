import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Release-line nudge end to end: the committed nexus-core session-guard
 * bundle in `session-start` mode against a local stub of the Nexus
 * `session_list` endpoint.
 */
const BUNDLE = join(import.meta.dirname, "../../../plugins/nexus-core/hooks/session-guard.mjs")

let server: Server
let apiUrl: string
let sessions: Array<{ title: string; status: string }> = []
let requests: unknown[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") })
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ action: "session_list", sessions }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address()
  apiUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nx-sg-session-start-")))
  mkdirSync(join(root, ".git"))
  requests = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(branch: string, extraEnv: NodeJS.ProcessEnv = {}) {
  writeFileSync(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`)
  const { NEXUS_SESSION_GUARD_RELEASE_NUDGE: _a, NEXUS_PROJECT_ID: _b, ...base } = process.env
  return new Promise<{ code: number; stdout: string }>((resolveRun) => {
    const child = spawn(process.execPath, [BUNDLE, "session-start"], {
      cwd: root,
      env: {
        ...base,
        HOME: root,
        CLAUDE_PROJECT_DIR: root,
        NEXUS_API_URL: apiUrl,
        NEXUS_PRIVATE_TOKEN: "test-token",
        NEXUS_PROJECT_ID: "proj-1",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    let stdout = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.on("exit", (code) => resolveRun({ code: code ?? -1, stdout }))
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: root }))
  })
}

describe("session-guard bundle: session-start release-line nudge", () => {
  it("injects one additionalContext line when the open session is on another release line", async () => {
    sessions = [{ title: "staging/release-0.17.0: hotfixes", status: "open" }]
    const { code, stdout } = await run("staging/release-0.18.0")
    expect(code).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(out.hookSpecificOutput.additionalContext).toContain(
      'Branch staging/release-0.18.0 has no matching Nexus session (open: "staging/release-0.17.0: hotfixes")',
    )
    expect(requests).toEqual([
      {
        url: "/api/mcp/sessions",
        auth: "Bearer test-token",
        body: { action: "session_list", project_id: "proj-1" },
      },
    ])
  })

  it("stays silent when the open session matches the branch", async () => {
    sessions = [{ title: "staging/release-0.18.0: adapters", status: "open" }]
    const { code, stdout } = await run("staging/release-0.18.0")
    expect(code).toBe(0)
    expect(stdout).toBe("")
  })

  it("does not call the API on a non-release branch or when disabled", async () => {
    sessions = []
    expect((await run("main")).stdout).toBe("")
    expect((await run("staging/release-0.18.0", { NEXUS_SESSION_GUARD_RELEASE_NUDGE: "off" })).stdout).toBe("")
    expect(requests).toEqual([])
  })

  it("stays silent and exits 0 when the API is unreachable", async () => {
    const { code, stdout } = await run("staging/release-0.18.0", { NEXUS_API_URL: "http://127.0.0.1:9" })
    expect(code).toBe(0)
    expect(stdout).toBe("")
  })
})

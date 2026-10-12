import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Stop end to end with the committed nexus-core cost-control bundle: a
 * project linked to a non-default API with only project-local credentials
 * (`.nexus/config.toml` + `.nexus/credentials.toml`), no env, no global
 * config. The cost entry must reach that API.
 */
const BUNDLE = join(import.meta.dirname, "../../../plugins/nexus-core/hooks/cost-control.mjs")

let server: Server
let apiUrl: string
let requests: Array<{ url?: string; auth?: string; body: any }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") })
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ action: "session_append", entry_id: "e1" }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address()
  apiUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nx-cost-stop-")))
  mkdirSync(join(root, "project", ".git"), { recursive: true })
  mkdirSync(join(root, "project", ".nexus"))
  mkdirSync(join(root, "home"))
  requests = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Claude Code transcript as written live: MCP tools carry the `mcp__nexus__` prefix. */
function writeTranscript(): string {
  const path = join(root, "transcript.jsonl")
  const lines = [
    {
      message: { content: [{ type: "tool_use", id: "c1", name: "mcp__nexus__session_create", input: { title: "t" } }] },
    },
    {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: [{ type: "text", text: JSON.stringify({ action: "session_create", id: "s-1", title: "t" }) }],
          },
        ],
      },
    },
    { message: { role: "assistant", model: "claude-sonnet-5-5", usage: { input_tokens: 300, output_tokens: 90 } } },
  ]
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"))
  return path
}

function runStop(transcriptPath: string) {
  const project = join(root, "project")
  const {
    NEXUS_API_URL: _a,
    NEXUS_PRIVATE_TOKEN: _b,
    CLAUDE_PROJECT_DIR: _c,
    HELICONE_API_KEY: _d,
    ...base
  } = process.env
  return new Promise<number>((resolveRun) => {
    const child = spawn(process.execPath, [BUNDLE, "stop"], {
      cwd: project,
      env: { ...base, HOME: join(root, "home"), CLAUDE_PROJECT_DIR: project },
      stdio: ["pipe", "ignore", "ignore"],
    })
    child.on("exit", (code) => resolveRun(code ?? -1))
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", cwd: project, transcript_path: transcriptPath }))
  })
}

describe("cost-control bundle: Stop with project-local credentials", () => {
  it("appends a cost_snapshot to the project's API and logs the source without the token", async () => {
    const project = join(root, "project")
    writeFileSync(join(project, ".nexus", "config.toml"), `[project]\napi_url = "${apiUrl}"\n`)
    writeFileSync(join(project, ".nexus", "credentials.toml"), `token = "project-token"\n`)
    expect(await runStop(writeTranscript())).toBe(0)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: "/api/mcp/sessions",
      auth: "Bearer project-token",
      body: { action: "session_append", session_id: "s-1", entry_type: "cost_snapshot" },
    })
    const log = readFileSync(join(project, ".nexus", "cost-control.log"), "utf-8")
    expect(log).toContain('Nexus credentials from source "project"')
    expect(log).not.toContain("project-token")
  })

  it("records nothing and says so when no credentials resolve", async () => {
    expect(await runStop(writeTranscript())).toBe(0)
    expect(requests).toEqual([])
    expect(readFileSync(join(root, "project", ".nexus", "cost-control.log"), "utf-8")).toContain(
      "no Nexus credentials found",
    )
  })
})

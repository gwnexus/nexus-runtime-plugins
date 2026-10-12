import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { isEntrypoint } from "./entrypoint.ts"

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nx-entrypoint-")))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("isEntrypoint", () => {
  it("matches a path with a space against its percent-encoded module URL", () => {
    const file = join(root, "my project", "hook.mjs")
    mkdirSync(join(root, "my project"))
    writeFileSync(file, "")
    expect(pathToFileURL(file).href).toContain("my%20project")
    expect(isEntrypoint(pathToFileURL(file).href, file)).toBe(true)
  })

  it("resolves a symlinked argv path to the real module URL", () => {
    const real = join(root, "real.mjs")
    const link = join(root, "link.mjs")
    writeFileSync(real, "")
    symlinkSync(real, link)
    expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true)
  })

  it("is false for another module, a missing argv path, or no argv", () => {
    const file = join(root, "hook.mjs")
    writeFileSync(file, "")
    expect(isEntrypoint(pathToFileURL(join(root, "other.mjs")).href, file)).toBe(false)
    expect(isEntrypoint(pathToFileURL(file).href, join(root, "missing.mjs"))).toBe(false)
    expect(isEntrypoint(pathToFileURL(file).href, undefined)).toBe(false)
  })
})

/**
 * End-to-end against the committed nexus-core bundles: run from a directory
 * with a space in its name, directly and through a symlink, and assert that
 * the hook actually ran (wrote its output) instead of exiting 0 silently.
 */
describe("built nexus-core hook bundles from an encoded or symlinked path", () => {
  const hooksDir = join(import.meta.dirname, "..", "plugins", "nexus-core", "hooks")
  const cases: Array<{
    bundle: string
    mode: string
    payload: Record<string, unknown>
    writes: string
  }> = [
    {
      bundle: "session-guard.mjs",
      mode: "user-prompt-submit",
      payload: { hook_event_name: "UserPromptSubmit" },
      writes: ".nexus/session-guard-state.json",
    },
    {
      bundle: "headroom-intercept.mjs",
      mode: "post-tool-use",
      payload: {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_response: "x",
        session_id: "s",
      },
      writes: ".nexus/headroom-metrics-state.json",
    },
    {
      bundle: "agent-observer.mjs",
      mode: "",
      payload: { hook_event_name: "SessionStart", session_id: "s" },
      writes: ".nexus/claude/observer/events.jsonl",
    },
  ]

  function run(script: string, mode: string, payload: Record<string, unknown>, project: string) {
    return spawnSync(process.execPath, mode ? [script, mode] : [script], {
      cwd: project,
      env: {
        ...process.env,
        NEXUS_API_URL: "",
        NEXUS_PRIVATE_TOKEN: "",
        HOME: root,
        CLAUDE_PROJECT_DIR: project,
      },
      input: JSON.stringify({ ...payload, cwd: project }),
      encoding: "utf-8",
    })
  }

  for (const c of cases) {
    for (const via of ["a path with a space", "a symlink"] as const) {
      it(`${c.bundle}: runs when invoked via ${via}`, () => {
        const pluginDir = join(root, "plugin dir")
        mkdirSync(pluginDir)
        cpSync(join(hooksDir, c.bundle), join(pluginDir, c.bundle))
        let script = join(pluginDir, c.bundle)
        if (via === "a symlink") {
          symlinkSync(pluginDir, join(root, "linked"))
          script = join(root, "linked", c.bundle)
        }
        const project = join(root, "my project")
        mkdirSync(join(project, ".nexus"), { recursive: true })
        const res = run(script, c.mode, c.payload, project)
        expect(res.status).toBe(0)
        expect(existsSync(join(project, c.writes))).toBe(true)
      })
    }
  }
})

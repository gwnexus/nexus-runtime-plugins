import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProjectRoot, findGitTopLevel } from "./project-root.ts"

describe("resolveProjectRoot (Dispatch b7d15add)", () => {
  let root: string
  let sub: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "nx-project-root-")))
    sub = join(root, "src", "deep", "folder")
    mkdirSync(sub, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("prefers CLAUDE_PROJECT_DIR over cwd", () => {
    mkdirSync(join(root, ".git"))
    expect(resolveProjectRoot(sub, { CLAUDE_PROJECT_DIR: "/some/project" })).toBe("/some/project")
  })

  it("ignores a blank CLAUDE_PROJECT_DIR", () => {
    mkdirSync(join(root, ".git"))
    expect(resolveProjectRoot(sub, { CLAUDE_PROJECT_DIR: "  " })).toBe(root)
  })

  it("falls back to the git top-level of a subdirectory cwd", () => {
    mkdirSync(join(root, ".git"))
    expect(resolveProjectRoot(sub, {})).toBe(root)
  })

  it("treats a .git file (linked worktree / submodule) as the top-level", () => {
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n")
    expect(findGitTopLevel(sub)).toBe(root)
  })

  it("returns null when neither CLAUDE_PROJECT_DIR nor a git top-level exists", () => {
    // tmpdir() itself is not inside a git checkout on any supported CI/dev host.
    expect(resolveProjectRoot(sub, {})).toBeNull()
  })
})

/**
 * End-to-end against the committed nexus-core bundles: a hook fired with the
 * session's cwd in a subdirectory must never create `.nexus/` there.
 */
describe("built nexus-core hook bundles with cwd in a subdirectory", () => {
  const hooksDir = join(import.meta.dirname, "..", "plugins", "nexus-core", "hooks")
  const cases: Array<{ bundle: string; mode: string; payload: Record<string, unknown>; writes: string }> = [
    {
      bundle: "session-guard.mjs",
      mode: "user-prompt-submit",
      payload: { hook_event_name: "UserPromptSubmit" },
      writes: "session-guard-state.json",
    },
    {
      bundle: "headroom-intercept.mjs",
      mode: "post-tool-use",
      payload: { hook_event_name: "PostToolUse", tool_name: "Read", tool_response: "x", session_id: "s" },
      writes: "headroom-metrics-state.json",
    },
    { bundle: "compaction-plus.mjs", mode: "pre-compact", payload: { hook_event_name: "PreCompact" }, writes: "" },
    { bundle: "routing-guard.mjs", mode: "session-start", payload: { hook_event_name: "SessionStart" }, writes: "" },
    { bundle: "cost-control.mjs", mode: "stop", payload: { hook_event_name: "Stop" }, writes: "" },
  ]

  let root: string
  let sub: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "nx-bundle-root-")))
    sub = join(root, "src", "app", "[id]")
    mkdirSync(sub, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function run(bundle: string, mode: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv) {
    const { CLAUDE_PROJECT_DIR: _drop, ...baseEnv } = process.env
    return spawnSync(process.execPath, [join(hooksDir, bundle), mode], {
      cwd: sub,
      env: { ...baseEnv, NEXUS_API_URL: "", NEXUS_PRIVATE_TOKEN: "", HOME: root, ...env },
      input: JSON.stringify({ ...payload, cwd: sub }),
      encoding: "utf-8",
    })
  }

  for (const c of cases) {
    it(`${c.bundle}: writes under the git top-level, never under cwd`, () => {
      mkdirSync(join(root, ".git"))
      const res = run(c.bundle, c.mode, c.payload, {})
      expect(res.status).toBe(0)
      expect(existsSync(join(sub, ".nexus"))).toBe(false)
      if (c.writes) expect(existsSync(join(root, ".nexus", c.writes))).toBe(true)
    })

    it(`${c.bundle}: honors CLAUDE_PROJECT_DIR`, () => {
      const res = run(c.bundle, c.mode, c.payload, { CLAUDE_PROJECT_DIR: root })
      expect(res.status).toBe(0)
      expect(existsSync(join(sub, ".nexus"))).toBe(false)
      if (c.writes) expect(existsSync(join(root, ".nexus", c.writes))).toBe(true)
    })

    it(`${c.bundle}: writes nothing when no project root resolves`, () => {
      const res = run(c.bundle, c.mode, c.payload, {})
      expect(res.status).toBe(0)
      expect(existsSync(join(sub, ".nexus"))).toBe(false)
      expect(existsSync(join(root, ".nexus"))).toBe(false)
    })
  }
})

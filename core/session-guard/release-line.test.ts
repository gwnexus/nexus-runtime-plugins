import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkReleaseLine,
  evaluateReleaseLine,
  fetchOpenSessions,
  isReleaseNudgeEnabled,
  readGitBranch,
  titleMatchesBranch,
} from "./release-line.ts"

const BRANCH = "staging/release-0.18.0"

describe("evaluateReleaseLine", () => {
  it("is in line when an open session title starts with the branch name", () => {
    expect(evaluateReleaseLine(BRANCH, [{ title: `${BRANCH}: adapters` }])).toEqual({ action: "in_line" })
    expect(evaluateReleaseLine(BRANCH, [{ title: "other" }, { title: BRANCH }])).toEqual({ action: "in_line" })
  })

  it("nudges when the open session names a different release line", () => {
    const r = evaluateReleaseLine(BRANCH, [{ title: "staging/release-0.17.0: hotfixes" }])
    expect(r.action).toBe("nudge")
    if (r.action !== "nudge") return
    expect(r.message).toBe(
      '[nexus-session-guard] Branch staging/release-0.18.0 has no matching Nexus session (open: "staging/release-0.17.0: hotfixes"). ' +
        'Per project rule: close it with a summary (/nexus-session-close) and start "staging/release-0.18.0: <focus>" (/nexus-init).',
    )
  })

  it("nudges when there is no open session", () => {
    const r = evaluateReleaseLine(BRANCH, [])
    expect(r.action).toBe("nudge")
    if (r.action !== "nudge") return
    expect(r.message).toContain("(no open session)")
    expect(r.message).not.toContain("/nexus-session-close")
  })

  it("skips non-release branches, detached HEAD and an unknown session list", () => {
    expect(evaluateReleaseLine("main", [])).toEqual({ action: "skip", reason: "not_release_branch" })
    expect(evaluateReleaseLine("staging/release-0.18", [])).toEqual({ action: "skip", reason: "not_release_branch" })
    expect(evaluateReleaseLine("feature/staging/release-0.18.0", [])).toEqual({
      action: "skip",
      reason: "not_release_branch",
    })
    expect(evaluateReleaseLine(null, [])).toEqual({ action: "skip", reason: "no_branch" })
    expect(evaluateReleaseLine(BRANCH, null)).toEqual({ action: "skip", reason: "sessions_unknown" })
  })

  it("does not treat a longer version as the same line", () => {
    expect(titleMatchesBranch("staging/release-0.18.01: x", BRANCH)).toBe(false)
    expect(titleMatchesBranch("staging/release-0.18.0 wrap-up", BRANCH)).toBe(true)
  })

  it("truncates a long open title", () => {
    const r = evaluateReleaseLine(BRANCH, [{ title: "x".repeat(200) }])
    if (r.action !== "nudge") throw new Error("expected nudge")
    expect(r.message).toContain(`"${"x".repeat(77)}..."`)
  })
})

describe("isReleaseNudgeEnabled", () => {
  it("defaults to on and accepts off/0/false", () => {
    expect(isReleaseNudgeEnabled({})).toBe(true)
    expect(isReleaseNudgeEnabled({ NEXUS_SESSION_GUARD_RELEASE_NUDGE: "on" })).toBe(true)
    for (const v of ["off", "0", "false", " OFF "])
      expect(isReleaseNudgeEnabled({ NEXUS_SESSION_GUARD_RELEASE_NUDGE: v })).toBe(false)
  })
})

describe("readGitBranch and checkReleaseLine", () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "nx-release-line-")))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function gitHead(content: string) {
    mkdirSync(join(root, ".git"), { recursive: true })
    writeFileSync(join(root, ".git", "HEAD"), content)
  }

  it("reads the branch, follows a worktree .git file, and returns null when detached or no git", () => {
    expect(readGitBranch(root)).toBeNull()
    gitHead(`ref: refs/heads/${BRANCH}\n`)
    expect(readGitBranch(root)).toBe(BRANCH)
    gitHead("0123456789abcdef0123456789abcdef01234567\n")
    expect(readGitBranch(root)).toBeNull()

    const wt = join(root, "wt")
    const wtGitDir = join(root, ".git", "worktrees", "wt")
    mkdirSync(wtGitDir, { recursive: true })
    mkdirSync(wt)
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/staging/release-1.2.3\n")
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGitDir}\n`)
    expect(readGitBranch(wt)).toBe("staging/release-1.2.3")
  })

  const env = { NEXUS_PROJECT_ID: "p" }
  const config = () => ({ apiUrl: "https://nexus.invalid", token: "t" })

  it("looks up sessions only on a release branch and nudges on mismatch", async () => {
    const lookup = vi.fn().mockResolvedValue([{ title: "staging/release-0.17.0: x" }])
    gitHead("ref: refs/heads/main\n")
    expect(await checkReleaseLine(root, env, lookup, config)).toEqual({ action: "skip", reason: "not_release_branch" })
    expect(lookup).not.toHaveBeenCalled()

    gitHead(`ref: refs/heads/${BRANCH}\n`)
    const r = await checkReleaseLine(root, env, lookup, config)
    expect(r?.action).toBe("nudge")
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: "https://nexus.invalid" }), "p")
  })

  it("returns null when disabled and stays silent without credentials", async () => {
    gitHead(`ref: refs/heads/${BRANCH}\n`)
    const lookup = vi.fn()
    expect(
      await checkReleaseLine(root, { ...env, NEXUS_SESSION_GUARD_RELEASE_NUDGE: "off" }, lookup, config),
    ).toBeNull()
    expect(await checkReleaseLine(root, env, lookup, () => null)).toEqual({
      action: "skip",
      reason: "sessions_unknown",
    })
    // no project id: no NEXUS_PROJECT_ID and no .nexus/AGENTS.md
    expect(await checkReleaseLine(root, {}, lookup, config)).toEqual({ action: "skip", reason: "sessions_unknown" })
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("fetchOpenSessions", () => {
  afterEach(() => vi.unstubAllGlobals())
  const config = { apiUrl: "https://nexus.invalid", token: "t" }

  it("posts session_list and returns open session titles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ sessions: [{ title: "a", status: "open" }, { title: "b", status: "closed" }, { id: "x" }] }),
        ),
      )
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchOpenSessions(config, "p")).toEqual([{ title: "a" }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://nexus.invalid/api/mcp/sessions")
    expect(JSON.parse(init.body)).toEqual({ action: "session_list", project_id: "p" })
  })

  it("returns null on HTTP errors, bad payloads and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x", { status: 500 })))
    expect(await fetchOpenSessions(config, "p")).toBeNull()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")))
    expect(await fetchOpenSessions(config, "p")).toBeNull()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await fetchOpenSessions(config, "p")).toBeNull()
  })
})

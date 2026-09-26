import { readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import type { RepoInfo } from "./types.ts"

/**
 * Resolve the repository name and linked-worktree path for `cwd` by walking
 * up to the nearest `.git` entry -- filesystem only, no `git` subprocess
 * (the observer runs on every tool call and must stay well under 20 ms).
 *
 * - `.git` directory: `cwd` is inside a normal checkout; repository is the
 *   basename of that directory, worktree is null.
 * - `.git` file pointing at `<main>/.git/worktrees/<name>`: linked worktree;
 *   repository is the basename of `<main>`, worktree is the directory that
 *   holds the `.git` file.
 * - `.git` file pointing anywhere else (submodule, separate git dir): treated
 *   like a normal checkout.
 */
export function resolveRepoInfo(cwd: string | null | undefined): RepoInfo {
  if (!cwd) return { repository: null, worktree: null }
  let dir = resolve(cwd)
  for (let i = 0; i < 64; i++) {
    const gitPath = resolve(dir, ".git")
    const kind = entryKind(gitPath)
    if (kind === "dir") return { repository: basename(dir), worktree: null }
    if (kind === "file") return fromGitFile(dir, gitPath)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { repository: null, worktree: null }
}

function entryKind(path: string): "dir" | "file" | null {
  try {
    const st = statSync(path)
    if (st.isDirectory()) return "dir"
    if (st.isFile()) return "file"
    return null
  } catch {
    return null
  }
}

function fromGitFile(topLevel: string, gitFile: string): RepoInfo {
  try {
    const match = readFileSync(gitFile, "utf-8").match(/^gitdir:\s*(.+)$/m)
    if (match) {
      const raw = match[1].trim()
      const gitDir = isAbsolute(raw) ? raw : resolve(topLevel, raw)
      const wt = gitDir.replace(/\\/g, "/").match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/)
      if (wt) return { repository: basename(wt[1]), worktree: topLevel }
    }
  } catch {
    // unreadable .git file -- fall through to plain checkout
  }
  return { repository: basename(topLevel), worktree: null }
}

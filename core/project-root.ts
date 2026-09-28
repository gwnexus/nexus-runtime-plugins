import { statSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * Resolve the project root for a Claude Code hook invocation (Dispatch
 * `b7d15add`, nexus-app).
 *
 * The hook payload's `cwd` is the session's *current* working directory,
 * which moves whenever the agent `cd`s into a subfolder. Using it directly
 * as the `.nexus/` base created stray `.nexus/` folders all over the tree and
 * split adapter state across directories.
 *
 * Resolution order:
 *   1. `CLAUDE_PROJECT_DIR` (set by Claude Code for every hook process)
 *   2. git top-level of `cwd` (nearest ancestor holding a `.git` dir or file)
 *   3. null -- the caller must skip writing; never fall back to `cwd` itself.
 */
export function resolveProjectRoot(
  cwd: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const projectDir = env.CLAUDE_PROJECT_DIR?.trim()
  if (projectDir) return resolve(projectDir)
  return findGitTopLevel(cwd ?? process.cwd())
}

/**
 * Walk up from `start` to the nearest directory containing `.git` (a
 * directory for normal checkouts, a file for linked worktrees/submodules).
 * Filesystem only, no `git` subprocess -- hooks run on every tool call.
 */
export function findGitTopLevel(start: string): string | null {
  let dir = resolve(start)
  for (let i = 0; i < 64; i++) {
    if (hasGitEntry(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function hasGitEntry(dir: string): boolean {
  try {
    const st = statSync(resolve(dir, ".git"))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

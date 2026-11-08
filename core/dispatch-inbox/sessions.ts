import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isSafeId, type SessionFile } from "./types.ts"

/**
 * Session registration for the Dispatch runner.
 *
 * The file holds the session's messaging token, so it is created with mode
 * 0600 in a 0700 directory, written to a temp file first and renamed into
 * place (the runner never reads a half-written file). Callers must never log
 * the token or copy it anywhere else.
 */

export function sessionsDir(stateDir: string): string {
  return join(stateDir, "sessions")
}

export function sessionFilePath(stateDir: string, sessionId: string): string {
  return join(sessionsDir(stateDir), `${sessionId}.json`)
}

/**
 * Build the session file from the session's environment. Null unless both
 * `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are set and
 * the session id is usable as a file name.
 */
export function buildSessionFile(
  sessionId: unknown,
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
): SessionFile | null {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim()
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN?.trim()
  if (!socket || !token || !isSafeId(sessionId)) return null
  return {
    session_id: sessionId,
    cwd,
    socket,
    token,
    started_at: now.toISOString(),
  }
}

/** Write the file atomically with mode 0600. Returns false on any error. */
export function writeSessionFile(stateDir: string, file: SessionFile): boolean {
  const dir = sessionsDir(stateDir)
  const tmp = join(dir, `.${file.session_id}.${process.pid}.tmp`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, sessionFilePath(stateDir, file.session_id))
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    return false
  }
}

/** Delete the session's file. Returns true when a file was removed. */
export function removeSessionFile(stateDir: string, sessionId: unknown): boolean {
  if (!isSafeId(sessionId)) return false
  try {
    unlinkSync(sessionFilePath(stateDir, sessionId))
    return true
  } catch {
    return false
  }
}

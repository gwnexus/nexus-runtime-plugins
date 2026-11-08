# nexus-dispatch-inbox (Claude Code adapter)

Claude Code-only plugin (no OpenCode counterpart yet). It connects running
Claude Code sessions to the Nexus CLI's Dispatch runner
(`nexus dispatch listen`), so a new Dispatch or a reply reaches the agent as
a short notice inside the running session instead of only as a desktop
notification.

Core logic lives in [`core/dispatch-inbox/`](../../../core/dispatch-inbox);
this adapter wires it to the `SessionStart` and `SessionEnd` hooks.

## What it does

All files live under the Nexus CLI's state directory,
`~/.config/nexus/state/dispatch/`.

**`SessionStart` (`session-start`)**

1. **Session registration.** Writes `sessions/<session_id>.json`:

   ```json
   { "session_id": "...", "cwd": "/abs/project/root", "socket": "...", "token": "...", "started_at": "2026-11-08T05:33:14.924Z" }
   ```

   `socket` and `token` come from the session's own
   `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`
   (Claude Code's cross-session inbox). The file is written atomically
   (temp file + rename) with mode 0600 (a missing directory is created with 0700), and only when
   both variables are set. `cwd` is the project root. The runner maps it to
   its git repository and pushes notices only to sessions of bound
   repositories, and only while the socket exists.
2. **Catch-up.** Notices queued while no session was running are added to
   the new session as `additionalContext`. The adapter reads
   `notices/<project_id>.jsonl` (written by the runner) for the session's
   Nexus project. A notice counts as delivered when its id appears in
   `notices/<project_id>.delivered.runner.jsonl` (runner pushes) or
   `notices/<project_id>.delivered.claude.jsonl` (this hook). Up to 10
   undelivered notices from the last 7 days, newest first, go into the
   context. Each is then appended to `.delivered.claude.jsonl`
   (append-only, written only by this hook), so it is shown exactly once.
   This is also the delivery path for sessions whose `crossSessionInbound`
   setting is `hold` or `refuse`, where the runner pushes nothing.

**`SessionEnd` (`session-end`):** deletes the session file. A file left behind
by a crashed session is tolerated: the runner skips sessions whose socket is
gone.

The project id comes from `NEXUS_PROJECT_ID`, then `.nexus/AGENTS.md`, then
`[project] id` in `.nexus/config.toml`. Without one, the catch-up is skipped.
Registration still happens.

## Guarantees

- The messaging token is written only to the 0600 session file. It never
  appears in logs, `.nexus/` state, hook output or any Nexus API call.
- Notices are short pointers (Dispatch id, title, peer) written by the
  runner. This hook never reads or forwards a Dispatch body and makes no
  network calls.
- Concurrent session starts in one project take a short lock
  (`notices/<project_id>.claude.lock`), so a notice is not shown twice.
- The hook always exits 0 and never blocks the session.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `NEXUS_DISPATCH_INBOX` | on | `off`, `false` or `0` disables both hooks. |
| `NEXUS_DISPATCH_STATE_DIR` | `~/.config/nexus/state/dispatch` | Override the state directory. |
| `NEXUS_PROJECT_ID` | from `.nexus/` | Project whose notice queue is read. |

Whether the runner may push into a session is governed by Claude Code's
`crossSessionInbound` setting (`accept`, `hold`, `refuse`). The runner reads
the strictest value across managed, user, project and project-local
settings. When the setting is unset, it pushes.

## Installation

Shipped in the `nexus-core` plugin (`hooks/dispatch-inbox.mjs`). For a manual
install, add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node adapters/claude-code/dispatch-inbox/nexus-dispatch-inbox.ts session-start" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node adapters/claude-code/dispatch-inbox/nexus-dispatch-inbox.ts session-end" }] }
    ]
  }
}
```

## Logs

`.nexus/dispatch-inbox.log` in the project root: registration, catch-up
counts and notice ids, never the token.

## Testing

```bash
npm test -- core/dispatch-inbox adapters/claude-code/dispatch-inbox
```

The tests cover:

- **Session file:** built only with both variables, mode 0600 in a 0700 directory, overwritten on resume, removed on `SessionEnd`.
- **Notice selection:** malformed queue lines are skipped, both delivery files are honoured, newest first, capped at 10, older than 7 days left out.
- **Exactly once:** a notice is delivered across two consecutive sessions only once.
- **Project id:** resolved from config, unsafe ids are rejected.
- **Built bundle:** runs end to end, and no file other than the session file contains the token.

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

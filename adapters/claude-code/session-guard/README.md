# nexus-session-guard (Claude Code adapter)

Claude Code hook adapter for `nexus-session-guard`, part of the ADR-C05
core/adapters restructure (Track B2, Dispatch `dc5fdf9a`).

**Capability matrix status:** `partial` (see `session_guard` entry in
`capability-matrix.v1.json`). Event granularity/ordering differs from the
OpenCode adapter's `tool.execute.after` + `message.updated` stream.

## How it differs from the OpenCode adapter

Claude Code invokes hooks as short-lived external processes (one per hook
event) rather than a single long-lived in-process plugin. State (turn
counters, last-append index) is therefore persisted to
`.nexus/session-guard-state.json` between invocations via
`core/state-store.ts`, instead of held in memory.

Shared trigger-detection logic (which tools trigger, Bash read-only
heuristic, reminder threshold/debounce) lives in `core/session-guard/logic.ts`
and is identical between the OpenCode and Claude Code adapters.

## Hook mapping

| OpenCode | Claude Code | Notes |
|----------|-------------|-------|
| `event` (`message.updated`, role=user) | `UserPromptSubmit` | Fires once per user turn; a closer semantic match than OpenCode's per-message dedup, but not verified byte-identical in ordering. |
| plugin load + first `tool.execute.after` | `SessionStart` (matcher `startup\|resume\|clear`) | Release-line nudge (see below), returned via `hookSpecificOutput.additionalContext`. |
| `tool.execute.after` | `PostToolUse` (matcher `Edit\|Write\|MultiEdit\|Bash\|nexus_task_create\|nexus_adr_create\|nexus_adr_decide\|nexus_session_append\|mcp__nexus__task_create\|mcp__nexus__adr_create\|mcp__nexus__adr_decide\|mcp__nexus__session_append`) | Reminder is returned via `hookSpecificOutput.additionalContext` instead of mutating tool output in place. |

## Installation

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/session-guard/nexus-session-guard.ts session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/session-guard/nexus-session-guard.ts user-prompt-submit"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|Bash|nexus_task_create|nexus_adr_create|nexus_adr_decide|nexus_session_append|mcp__nexus__task_create|mcp__nexus__adr_create|mcp__nexus__adr_decide|mcp__nexus__session_append",
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/session-guard/nexus-session-guard.ts post-tool-use"
          }
        ]
      }
    ]
  }
}
```

**Confirmed (2026-09-20):** `hookSpecificOutput.additionalContext` is the
correct field for both `PostToolUse` and `UserPromptSubmit`, verified
against the official Claude Code hooks reference. No changes needed for
this adapter.

**Fixed (Dispatch `0e38cf7b` review, 2026-09-24):** Claude Code sends Nexus
MCP tool calls as `mcp__nexus__task_create`, `mcp__nexus__adr_create`, etc.,
not the OpenCode-style `nexus_task_create` names this adapter's matcher and
internal trigger checks originally expected -- the same tool-name-mismatch
bug found and fixed in `headroom-intercept`. The `matcher` above now includes
both forms, and `normalizeClaudeToolName()` maps the MCP-prefixed name to the
core naming convention before it reaches `evaluateToolCompletion()`.

## Release-line nudge

Projects that keep one Nexus session per release line title it
`staging/release-X.Y.Z: <focus>`. At session start the guard reads the
current branch of the project root (`.git/HEAD`, no subprocess). Only on a
`staging/release-X.Y.Z` branch it fetches the project's open Nexus sessions
(`session_list` via the Nexus REST API, 3 s timeout) and, when no open
session title starts with the branch name, injects one line asking the
agent to close the old session with a summary (`/nexus-session-close`) and
start `staging/release-X.Y.Z: <focus>` (`/nexus-init`). The guard never
closes or creates sessions itself. Not a git checkout, detached HEAD, other
branches, missing credentials or project id (`NEXUS_PROJECT_ID` or the
`project_id` in `.nexus/AGENTS.md`), or a failed lookup: no nudge.

Disable with `NEXUS_SESSION_GUARD_RELEASE_NUDGE=off` (default on).

## Logs

Debug logs are written to `.nexus/session-guard.log` (shared log file with
the OpenCode adapter). Persisted counters live in
`.nexus/session-guard-state.json`.

## Testing

```bash
npm test -- adapters/claude-code/session-guard
```

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

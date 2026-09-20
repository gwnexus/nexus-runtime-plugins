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
| `tool.execute.after` | `PostToolUse` (matcher `Edit\|Write\|MultiEdit\|Bash\|nexus_task_create\|nexus_adr_create\|nexus_adr_decide\|nexus_session_append`) | Reminder is returned via `hookSpecificOutput.additionalContext` instead of mutating tool output in place. |

## Installation

Add to `.claude/settings.json`:

```json
{
  "hooks": {
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
        "matcher": "Edit|Write|MultiEdit|Bash|nexus_task_create|nexus_adr_create|nexus_adr_decide|nexus_session_append",
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

**Before production use:** verify the hook input/output JSON field names
(`tool_name`, `tool_input`, `hookSpecificOutput.additionalContext`) against
the current Claude Code hooks reference — the exact schema has changed
across Claude Code versions and was not runtime-verified as part of this
Track B2 pilot.

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

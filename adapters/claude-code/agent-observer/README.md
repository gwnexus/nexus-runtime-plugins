# nexus-agent-observer (Claude Code adapter)

Claude Code hook adapter that feeds the Agent Observability pane. It appends one `nexus.agent-observation.v1`
JSON line per hook event to

```
<agentic_root>/claude/observer/events.jsonl     # normally .nexus/claude/observer/events.jsonl
```

which `nexus status --agents` (nexus-cli) renders. The record schema is
published at
[`plugins/nexus-core/schemas/nexus.agent-observation.v1.schema.json`](../../../plugins/nexus-core/schemas/nexus.agent-observation.v1.schema.json).
The mapping logic lives in [`core/agent-observer/`](../../../core/agent-observer).

Claude Code only: OpenCode has no equivalent pane, so there is no OpenCode adapter.

## Events

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`,
`StopFailure`, `SessionEnd`, with matcher `*` for the three tool events. The
adapter reads the event name from `hook_event_name`, so every registration
uses the same command with no mode argument.

`SubagentStart`, `PostToolUseFailure`, `StopFailure` and `SessionEnd` are
within the CCX compatibility range (`>=2.1.257 <3.0.0`). All payload shapes
the mapping relies on were captured live from Claude Code 2.1.283 and are
committed as redacted fixtures in `fixtures/`.

## How agents are derived

| Agent | `agentId` | Started by | Finished by |
|---|---|---|---|
| main | session id | `SessionStart` / first event | `Stop` (done), `StopFailure` (failed), `SessionEnd` |
| subagent | Claude Code `agent_id` | `SubagentStart` | `SubagentStop`, or a `<task-notification>` for background agents |
| background shell | `tool_use_id` of the Bash call | `PreToolUse(Bash)` with `run_in_background: true` | `<task-notification>` with the shell's `backgroundTaskId` |

- Hooks fired inside a subagent carry `agent_id`, so tool events are attributed to the right agent.
- Parent linking: `PreToolUse(Agent|Task)` queues the spawn (caller, `description`, `subagent_type`, which defaults to `general-purpose` when omitted). A foreground spawn fires `SubagentStart` first and is matched by type. A background spawn fires `PostToolUse(Agent)` (`status: "async_launched"`) first. In both cases `tool_response.agentId` is the authoritative link.
- Background completions reach the main agent as a `UserPromptSubmit` whose prompt is a `<task-notification>`. Only `<task-id>`, `<tool-use-id>` and `<status>` are parsed from it.
- `model` and token counts are not in any hook payload. On `Stop`/`SubagentStop` the adapter reads the documented `transcript_path` / `agent_transcript_path` incrementally, only the bytes appended since the last read. Input tokens = input + cache creation + cache read.

## Guarantees

- Always exits 0 and never writes to stdout. It uses no network and spawns no subprocesses (git info comes from the filesystem). Errors go to stderr at most.
- About 4 ms of work per event on top of about 26 ms of Node startup (measured on macOS, Node 22).
- Never writes tool inputs or outputs, prompt text beyond the 120-char task summary, env values or secrets.
- Writes only if the agentic root (`.nexus/`) already exists, so the output is always covered by the project's `.nexus/` git exclude.
- `events.jsonl` rotates to `events.1.jsonl` at 5 MB, keeping one generation.
- Linking state lives in `observer/state.json`, with entries pruned after 24 h. Concurrent hook processes (parallel tool calls, and background spawns where `PostToolUse` and `SubagentStart` race) are serialized with an `O_EXCL` lock file. The lock waits at most 50 ms and is taken over after 2 s if it looks stale.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CLAUDE_PROJECT_DIR` | hook `cwd` | Project root (set by Claude Code) |
| `NEXUS_AGENTIC_ROOT` | `<project>/.nexus` | Agentic root override, absolute or relative to the project |

## Hook configuration (standalone / `claude_hook_adapters`)

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "Notification":       [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "SubagentStart":      [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "StopFailure":        [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/nexus-agent-observer.mjs\"" }] }]
  }
}
```

In the `nexus-core` plugin the same wiring is already in `plugins/nexus-core/hooks/hooks.json`.

## Known gaps

- `Notification` is not emitted in headless (`claude -p`) runs, so its fixture uses the documented fields rather than a live capture.
- A background shell or background agent that is still running when the session ends gets no final `done` record. Claude Code sends no completion event for it, so consumers should treat such agents as ended when the session's `SessionEnd` arrives.
- The lock bounds its wait at 50 ms. Under extreme contention an update can still be lost rather than blocking Claude Code.

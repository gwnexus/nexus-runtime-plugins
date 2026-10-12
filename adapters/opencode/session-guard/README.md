# nexus-session-guard

An [OpenCode](https://opencode.ai) plugin that enforces session append discipline
for the [Nexus](https://nexus.gatewarden.eu) platform.

**Current version:** `v1.2.0`  
**Requires:** Nexus MCP server (active session)

## What it does

Agents frequently skip `nexus_session_append` calls after completing work,
leaving gaps in the session audit trail. This plugin detects code-changing tool
completions and injects a system reminder when no session entry has been
recorded since the last user instruction.

## How it works

```
User message → lastUserTurnIndex++
Agent calls Edit/Write/Bash → plugin checks: was session_append called?
  → YES (lastAppendTurnIndex >= lastUserTurnIndex): no action
  → NO: inject system reminder into tool output
Agent calls nexus_session_append → lastAppendTurnIndex = lastUserTurnIndex
```

### Trigger tools

| Tool | Condition |
|------|-----------|
| `Edit`, `Write`, `MultiEdit` | Always triggers |
| `Bash` | Only if command is non-read-only (heuristic filter) |
| `nexus_task_create` | Always triggers |
| `nexus_adr_create` | Always triggers |
| `nexus_adr_decide` | Always triggers |

### Hooks

- **`tool.execute.after`** — detects trigger tools and injects reminders
- **`event`** (`message.created`) — tracks user turn index
- **Release-line nudge** — checked once when the plugin loads; OpenCode has
  no session-start context injection, so the nudge is appended once to the
  first tool output (see below)

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

## Installation

Copy into your project's OpenCode plugins directory:

```bash
cp nexus-session-guard.ts /path/to/your-project/.opencode/plugins/
```

Note: this adapter imports shared logic from `core/`. If copying standalone,
also copy `core/logger.ts` and `core/session-guard/logic.ts` alongside it
(adjusting the relative import paths), or install from the full repo checkout.

Ensure `.opencode/package.json` includes the plugin SDK:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

## Testing

```bash
npm test -- adapters/opencode/session-guard
```

17 unit tests covering trigger detection, reminder injection, state machine
transitions, Bash heuristics, MCP content shape, and user turn tracking.

## Logs

Debug logs are written to `.nexus/session-guard.log`.

## Architecture Decision

See ADR-0066: Session Guard Plugin (`d5f0735d-bc48-44c9-be2a-96753206a264`, NEXUS-APP).

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

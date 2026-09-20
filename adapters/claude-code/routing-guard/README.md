# nexus-routing-guard (Claude Code adapter)

Claude Code hook adapter for `nexus-routing-guard`, part of the ADR-C05
core/adapters restructure (Track B2, Dispatch `dc5fdf9a`).

**Capability matrix status:** `partial` (see `routing_guard` entry in
`capability-matrix.v1.json`). No equivalent to OpenCode's
`experimental.chat.system.transform` (continuous in-session banner/
validation) exists in Claude Code. Per the dispatch's explicit instruction,
this gap is disclosed, not faked with a fragile workaround: validation here
only happens **once, before the session starts**, not continuously
mid-session.

The pure divergence-detection function (`detectRoutingWarnings`) and the
banner text formatter (`formatBanner`) live in
[`core/routing-guard/`](../../../core/routing-guard), shared verbatim with
the [OpenCode adapter](../../opencode/routing-guard).

## Key structural difference from the OpenCode adapter

OpenCode exposes `client.config.providers()` / `client.app.agents()` -- SDK
calls that return the live, merged provider/model catalog and agent routing
table directly from the running instance. **Claude Code has no equivalent
SDK surface for this plugin to query.**

**Confirmed live against nexus-cli v0.17.2 (2026-09-20, see Dispatch
`dc5fdf9a` reply from nexus-app):** `nexus pull`/`nexus init` writes two
files relative to the project's agentic root:

```
.nexus/generated/routing-catalog.json   -> { "model_routes": [{ route_alias, provider, model, lifecycle_status }, ...] }
.nexus/generated/agent-routing.json     -> { "actors": [{ slug, title, model_profile_id, is_primary, priority, ... }, ...] }
```

These are read by default and converted into the plugin's internal
`ProviderCatalog`/`AgentInfo[]` shape by
[`core/routing-guard/nexus-cli-catalog.ts`](../../../core/routing-guard/nexus-cli-catalog.ts),
which `detectRoutingWarnings()` then consumes unchanged. The env vars below
are only needed to override the default file location (e.g. for manual
testing with hand-written catalog/agent JSON in the plugin's own internal
shape, which is also still accepted as a fallback).

**Assumption not yet explicitly confirmed by nexus-app:** an actor's
`model_profile_id` corresponds 1:1 to a model route's `route_alias`. If
nexus-cli's actual linkage differs, `buildAgentInfoFromActors()` needs
correction — flagged in that module's code comments.

**Known caveat (confirmed by nexus-app, not a bug):** nexus-cli only injects
env vars into `.claude/settings.json` on first-creation of that file.
Projects with a pre-existing `.claude/settings.json` (e.g. from Track B1
testing) won't have the env vars until the file is deleted and regenerated
via `nexus pull --force`. This is now less of an issue since the adapter
finds the two files itself at their default location without needing the
env vars at all.

```bash
export NEXUS_ROUTING_GUARD_CATALOG_PATH=/path/to/provider-catalog.json  # optional override
export NEXUS_ROUTING_GUARD_AGENTS_PATH=/path/to/agent-routing.json     # optional override
```

If either file is missing, the check is skipped silently (fail-open,
matching the OpenCode adapter's never-block behavior) and logged as a
warning.

## Hard constraints (same as OpenCode adapter)

- **Silent when clean.** No confirmation banner, ever.
- **Never blocks session start.** Missing files, malformed JSON, or any
  other failure degrades to "no warning", never fatal.
- **Not continuous.** Explicitly a preflight-only check (see capability
  matrix disclosure); do not treat the absence of a mid-session warning as
  confirmation that routing is still valid.

## Installation

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/routing-guard/nexus-routing-guard.ts session-start"
          }
        ]
      }
    ]
  }
}
```

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `NEXUS_ROUTING_GUARD_ENABLED` | `true` | Set to `"false"` to disable the check entirely. |
| `NEXUS_ROUTING_GUARD_CATALOG_PATH` | `.nexus/generated/routing-catalog.json` | Override the catalog file path. |
| `NEXUS_ROUTING_GUARD_AGENTS_PATH` | `.nexus/generated/agent-routing.json` | Override the agent-routing file path. |

## Logs

Debug logs are written to `.nexus/routing-guard.log` (shared log file with
the OpenCode adapter).

## Testing

```bash
npm test -- adapters/claude-code/routing-guard core/routing-guard
```

7 unit tests for this adapter (env-var opt-out, missing-file fail-open
behavior, clean-config no-op, divergence banner generation, malformed-JSON
fail-open behavior, nexus-cli shape auto-detection with default paths, and
no-matching-route handling), plus 4 unit tests for the
`nexus-cli-catalog.ts` transform (provider grouping, `model_profile_id` ->
`route_alias` resolution, end-to-end divergence detection through the
transform).

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

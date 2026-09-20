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

This adapter therefore expects the provider catalog and agent routing table
to be supplied as JSON files via environment variables, mirroring the role
`opencode.json` plays for the OpenCode adapter:

```bash
export NEXUS_ROUTING_GUARD_CATALOG_PATH=/path/to/provider-catalog.json  # ProviderCatalog shape
export NEXUS_ROUTING_GUARD_AGENTS_PATH=/path/to/agent-routing.json     # AgentInfo[] shape
```

If either file is missing, the check is skipped silently (fail-open,
matching the OpenCode adapter's never-block behavior) and logged as a
warning.

**VERIFY BEFORE PRODUCTION USE:** whether `nexus pull`/`nexus init` actually
generates these two files for Claude Code projects. If not, this adapter has
no data source and the check is a no-op until that Nexus CLI-side work
lands. This is flagged explicitly because it is outside this repo's scope
to fix -- see the reply on Dispatch `dc5fdf9a`.

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
| `NEXUS_ROUTING_GUARD_CATALOG_PATH` | none | Path to a JSON file matching the `ProviderCatalog` shape. |
| `NEXUS_ROUTING_GUARD_AGENTS_PATH` | none | Path to a JSON file matching the `AgentInfo[]` shape. |

## Logs

Debug logs are written to `.nexus/routing-guard.log` (shared log file with
the OpenCode adapter).

## Testing

```bash
npm test -- adapters/claude-code/routing-guard
```

5 unit tests covering the env-var opt-out, missing-file fail-open behavior,
clean-config no-op, divergence banner generation, and malformed-JSON
fail-open behavior.

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

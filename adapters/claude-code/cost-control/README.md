# nexus-cost-control (Claude Code adapter)

Claude Code hook adapter for `nexus-cost-control`, part of the ADR-C05
core/adapters restructure (Track B2, Dispatch `dc5fdf9a`). This is the last
plugin in the Track B2 scope (`600-attribution-headers` is explicitly
excluded per ADR-C08).

**Capability matrix status:** `partial` (see `cost_control` entry in
`capability-matrix.v1.json`). Claude Code has no idle-detection event (no
equivalent to OpenCode's `session.idle`); cost summaries are instead
recorded around the `Stop` hook, which fires on a different cadence
(per-turn-ish) than OpenCode's idle-debounced summary.

All credential resolution, state extraction, the Helicone client,
formatting, and the Nexus API call live in
[`core/cost-control/`](../../../core/cost-control), shared verbatim with the
[OpenCode adapter](../../opencode/cost-control).

## Differences from the OpenCode adapter

1. **`Stop` instead of `session.idle`.** Same 5-minute debounce window and
   token-delta dedup guard as the OpenCode adapter, applied around `Stop`
   instead. This changes the *cadence* of recording (closer to per-turn than
   per-idle-period) -- disclosed in the capability matrix, not silently
   assumed equivalent.
2. **`nexus_cost_summary` is not implemented as a Claude Code hook script.**
   Per capability-matrix `custom_tools` = `none` for Claude Code (no
   custom-tool-registration hook exists), this on-demand tool must become an
   MCP tool on the Nexus MCP server instead -- same follow-up as the
   headroom-intercept retrieval tool gap. Not implemented in this repo.
3. **Session/token-delta state is persisted to disk**
   (`.nexus/cost-control-state.json`) between invocations, since Claude Code
   spawns a fresh process per hook event rather than keeping a long-lived
   plugin instance in memory.
4. **Transcript parsing.** Same `transcript_path` JSONL parser (tool_use /
   tool_result pairing) as the compaction-plus Claude Code adapter --
   duplicated rather than shared, since the two plugins were migrated
   independently in this pass; consider consolidating into a shared
   `core/claude-transcript.ts` helper in a follow-up if a third plugin needs
   it.
5. **Runtime fallback for Claude Max / subscription sessions
   (`cost_source: "runtime"`).** Claude Max sessions talk directly to
   Anthropic and never pass through the Helicone gateway, so
   `queryHeliconeSession` returns `null` for those sessions even though
   Helicone is configured. Rather than writing nothing, this adapter
   aggregates token counts directly from the transcript's assistant
   `message.usage` blocks (`input_tokens`, `output_tokens`,
   `cache_read_input_tokens`, `cache_creation_input_tokens`) and appends a
   token-only entry with `cost_usd: null` (never `0`, which would be
   indistinguishable from "ran and cost nothing") and `cost_source:
   "runtime"`. If no assistant messages are found in the transcript either,
   no entry is written. See Dispatch `515186c1`.

## Not covered by this fallback

Pointing `ANTHROPIC_BASE_URL` at Helicone would give the Claude Max lane
real token-level *and* cost-level observability (Helicone would see the
requests directly). That is a policy/credential-routing decision, not a
plugin change, and is intentionally out of scope here.

## VERIFY BEFORE PRODUCTION USE

This adapter assumes `transcript_path` (supplied in the `Stop` hook input)
points to a standard Claude Code transcript JSONL file -- not
runtime-verified against a live Claude Code install in this pass, same
caveat as the compaction-plus and routing-guard Claude Code adapters.

## Installation

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/cost-control/nexus-cost-control.ts stop"
          }
        ]
      }
    ]
  }
}
```

## Configuration

Same environment variables as the OpenCode adapter:

```bash
export HELICONE_API_KEY="sk-helicone-..."
export NEXUS_API_URL="https://nexus.gatewarden.eu"
export NEXUS_PRIVATE_TOKEN="nxs_pat_..."
```

## Logs

Shared log file with the OpenCode adapter: `.nexus/cost-control.log`.
Persisted debounce/dedup state: `.nexus/cost-control-state.json`.

## Testing

```bash
npm test -- adapters/claude-code/cost-control
```

7 unit tests covering transcript JSONL parsing, config-missing fail-open
behavior, missing-session-ID skip, cost-entry recording, debounce/dedup
across separate invocations, and the runtime-fallback token-only entry path
for sessions with no Helicone data.

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

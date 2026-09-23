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
5. **Native aggregation is the default, zero-config path; Helicone is
   optional enrichment (`cost_source: "runtime" | "helicone"`).** Per
   ADR-0040 (nexus-app), `queryHeliconeSession` is only consulted when
   `HELICONE_API_KEY` is configured, and is not a gating requirement for
   `handleStop` to run. When Helicone is absent, not configured, or
   configured but returns no data (e.g. Claude Max sessions, which talk
   directly to Anthropic and never pass through the Helicone gateway),
   this adapter aggregates token counts directly from the transcript's
   assistant `message.usage` blocks (`input_tokens`, `output_tokens`,
   `cache_read_input_tokens`, `cache_creation_input_tokens`) and appends a
   token-only entry with `cost_usd: null` (never `0`, which would be
   indistinguishable from "ran and cost nothing") and `cost_source:
   "runtime"`. If Helicone is configured and returns data, that metered
   entry (`cost_source: "helicone"`, real `cost_usd`) is preferred. If no
   assistant messages are found in the transcript either, no entry is
   written. `v1.1.0` briefly inverted this precedence (gated everything on
   `HELICONE_API_KEY` being configured) -- a drift from ADR-0040 introduced
   during the ADR-C05 restructure, corrected in `v1.2.0`. See Dispatch
   `515186c1` and `6298a740`.

## Native aggregation vs. Helicone enrichment

Pointing `ANTHROPIC_BASE_URL` at Helicone would give the Claude Max lane
real token-level *and* cost-level observability from Helicone directly
(rather than the transcript-derived token counts this adapter uses). That
is a policy/credential-routing decision, not a plugin change, and is
intentionally out of scope here.

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

`NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` are required; `HELICONE_API_KEY`
is optional and enables Helicone enrichment on top of the always-on native
aggregation:

```bash
export NEXUS_API_URL="https://nexus.gatewarden.eu"
export NEXUS_PRIVATE_TOKEN="nxs_pat_..."

# Optional: enables Helicone enrichment (metered cost_usd)
export HELICONE_API_KEY="sk-helicone-..."
```

## Logs

Shared log file with the OpenCode adapter: `.nexus/cost-control.log`.
Persisted debounce/dedup state: `.nexus/cost-control-state.json`.

## Testing

```bash
npm test -- adapters/claude-code/cost-control
```

10 unit tests covering transcript JSONL parsing, missing-Nexus-config
fail-open behavior, missing-session-ID skip, cost-entry recording,
debounce/dedup across separate invocations, and the zero-config native
token-only entry path for sessions with no Helicone data or no Helicone
key configured at all.

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

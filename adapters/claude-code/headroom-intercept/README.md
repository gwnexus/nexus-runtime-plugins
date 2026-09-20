# nexus-headroom-intercept (Claude Code adapter)

Claude Code hook adapter for `nexus-headroom-intercept`, part of the ADR-C05
core/adapters restructure (Track B2, Dispatch `dc5fdf9a`).

**Capability matrix status:** `full` (see `headroom_intercept` entry in
`capability-matrix.v1.json`) — Claude Code's `PostToolUse` hook natively
supports replacing tool output before the model sees it via
`hookSpecificOutput.updatedToolOutput`, confirmed against the official hooks
reference (code.claude.com/docs/en/hooks) on 2026-09-20.

All policy, compression, cache, and credential-resolution logic lives in
[`core/headroom-intercept/`](../../../core/headroom-intercept), shared
verbatim with the [OpenCode adapter](../../opencode/headroom-intercept). This
file only documents the Claude Code-specific wiring.

## Differences from the OpenCode adapter (both intentional, both disclosed)

1. **Retrieval tool is NOT implemented here.** Per capability-matrix
   `custom_tools` = `none` for Claude Code (no custom-tool-registration hook
   exists), `nexus_headroom_intercept_retrieve` cannot be a
   runtime-plugin-registered tool the way it is in OpenCode. This adapter
   still writes originals to the same on-disk cache
   (`.nexus/headroom-cache/`) used by the OpenCode adapter, so a future
   Nexus-MCP-server-side retrieval tool can read them — but it does not
   itself expose retrieval to the agent. A `debugRetrieve()` function is
   provided for manual/debugging use only (not wired to any hook).
   **Follow-up required:** expose `nexus_headroom_intercept_retrieve` as an
   MCP tool on the Nexus MCP server itself so Claude Code agents have a
   retrieval path — this is infrastructure work outside this repo.

2. **Project/credential gate is cached, not re-checked per tool call.**
   Claude Code spawns a fresh process per hook event (no long-lived plugin
   instance like OpenCode), so a live network preflight call on every single
   tool completion would add latency to every tool call. The gate result
   (mode, project ID, downgrade reason) is cached to
   `.nexus/headroom-gate-state.json` with a 10-minute TTL instead.
   OpenCode-specific SDK-version gating does not apply and is omitted.

3. **No `session.idle` equivalent.** Metrics are persisted to
   `.nexus/headroom-metrics-state.json` between invocations and flushed as a
   `session_summary` log line on the `Stop` hook, then reset.

## Confirmed hook output field (2026-09-20)

`hookSpecificOutput.updatedToolOutput` is the correct field to replace tool
output; `additionalContext` is a different field that only adds
supplementary text alongside the original result and does not replace it,
so this adapter no longer emits it. **Important confirmed caveat:** for
built-in tools (Bash, Read, etc.), a replacement value that doesn't match
the tool's native output schema is silently ignored — this plugin's policy
table only ever compresses `nexus_`/`headroom_`-prefixed MCP tool output
(not schema-validated by Claude Code), and explicitly `skip`s every
built-in tool, so a plain-string `updatedToolOutput` is always safe here. If
the policy table is ever extended to compress a built-in tool's output, that
entry must preserve the tool's native output shape instead.

## Installation

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "nexus_.*|headroom_.*",
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/headroom-intercept/nexus-headroom-intercept.ts post-tool-use"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/headroom-intercept/nexus-headroom-intercept.ts stop"
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
export HEADROOM_MODE=transform            # apply compression (default: observe)
export HEADROOM_REQUIRE_PREFLIGHT=true    # strict: force observe if project gate fails
export HEADROOM_DEBUG=true                # verbose JSONL trace logging
```

## Logs

Shared JSONL log file with the OpenCode adapter:
`.nexus/headroom-intercept.jsonl`.

## Testing

```bash
npm test -- adapters/claude-code/headroom-intercept
```

11 unit tests covering `tool_response` shape normalization (string vs. MCP
`content[]`), policy routing, observe vs. transform mode output, cross-process
metrics persistence, and the `Stop` hook's session summary flush.

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

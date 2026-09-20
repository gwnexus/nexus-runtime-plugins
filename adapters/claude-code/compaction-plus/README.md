# nexus-compaction-plus (Claude Code adapter)

Claude Code hook adapter for `nexus-compaction-plus`, part of the ADR-C05
core/adapters restructure (Track B2, Dispatch `dc5fdf9a`).

**Capability matrix status:** `partial` (see `compaction_plus` entry in
`capability-matrix.v1.json`). The mechanism exists (`PreCompact` /
`PostCompact` hooks) and `PostCompact` supplies the generated compact summary
directly per the hooks reference -- actually simpler than OpenCode's
two-phase `session.compacted` + `message.updated` diffing approach -- but
interactive vs. `claude -p` (headless) hook behavior has **not** been
verified identical in this pass.

All state extraction, context building, and the Nexus API call live in
[`core/compaction-plus/`](../../../core/compaction-plus), shared verbatim
with the [OpenCode adapter](../../opencode/compaction-plus). This file only
documents the Claude Code-specific wiring (transcript parsing, hook
registration).

## How it differs from the OpenCode adapter

| OpenCode | Claude Code | Notes |
|----------|-------------|-------|
| `experimental.session.compacting` (pre-compaction context injection) | `PreCompact` (matcher `manual\|auto`) | Both read the conversation history for Nexus session/project state and inject it as context before compaction. |
| `session.compacted` + `message.updated` (two-phase: record OpenCode session ID, then wait for the generated summary message) | `PostCompact` | Per the hooks reference, `PostCompact` supplies the generated compact summary directly in the hook input -- no two-phase wait needed. **Not yet verified against a live install.** |

Claude Code transcripts are parsed from the `transcript_path` JSONL file
supplied in the hook input (one JSON object per line; `tool_use` blocks are
paired with their `tool_result` by `tool_use_id`) into the same
`NormalizedToolCall[]` shape the OpenCode adapter builds from message parts,
so `core/compaction-plus/state.ts`'s `extractNexusState()` is identical
between adapters.

## VERIFY BEFORE PRODUCTION USE

- The exact `PreCompact`/`PostCompact` hook input JSON shape. This adapter
  assumes `transcript_path` points to a standard Claude Code transcript JSONL
  file and that `PostCompact` input includes a `summary` field with the
  generated compact summary text -- neither was runtime-verified against a
  live Claude Code install in this pass.
- Interactive vs. headless (`claude -p`) parity, per the capability matrix
  disclosure. Add an integration test covering both modes and pin a minimum
  Claude Code version before removing the `partial` label.

## Installation

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "manual|auto",
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/compaction-plus/nexus-compaction-plus.ts pre-compact"
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node adapters/claude-code/compaction-plus/nexus-compaction-plus.ts post-compact"
          }
        ]
      }
    ]
  }
}
```

## Logs

Shared log file with the OpenCode adapter: `.nexus/compaction-plus.log`.

## Testing

```bash
npm test -- adapters/claude-code/compaction-plus
```

10 unit tests covering transcript JSONL parsing (tool_use/tool_result
pairing, unmatched calls, malformed lines), pre-compact context injection,
and post-compact summary posting.

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

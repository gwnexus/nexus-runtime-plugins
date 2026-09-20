# nexus-compaction-plus (Claude Code adapter)

Claude Code hook adapter for `nexus-compaction-plus`, part of the ADR-C05
core/adapters restructure (Track B2, Dispatch `dc5fdf9a`).

**Capability matrix status:** `partial` (see `compaction_plus` entry in
`capability-matrix.v1.json`). Confirmed against the official Claude Code
hooks reference on 2026-09-20 (see Dispatch `dc5fdf9a` reply from
nexus-app): `PostCompact` supplies the generated compact summary directly in
a field named `compact_summary` (a bug where this adapter previously read
`summary` was fixed in this pass) -- simpler than OpenCode's two-phase
`session.compacted` + `message.updated` diffing approach for the
post-compaction half. However, `PreCompact` has **no** documented mechanism
to inject content at all (`additionalContext` is not a supported output
field for `PreCompact`/`PostCompact` -- confirmed, not an oversight), so
OpenCode's pre-compaction context injection has **no Claude Code
equivalent whatsoever**. Interactive vs. `claude -p` (headless) hook
behavior parity remains unverified.

All state extraction, context building, and the Nexus API call live in
[`core/compaction-plus/`](../../../core/compaction-plus), shared verbatim
with the [OpenCode adapter](../../opencode/compaction-plus). This file only
documents the Claude Code-specific wiring (transcript parsing, hook
registration).

## How it differs from the OpenCode adapter

| OpenCode | Claude Code | Notes |
|----------|-------------|-------|
| `experimental.session.compacting` (pre-compaction context injection) | **No equivalent.** `PreCompact` hook fires, but `additionalContext` is not a supported output field for this event per the official hooks reference -- there is no documented way to inject content before compaction in Claude Code. `handlePreCompact()` is a no-op (diagnostic logging only). This is a genuine, permanent capability gap, not an implementation bug. |
| `session.compacted` + `message.updated` (two-phase: record OpenCode session ID, then wait for the generated summary message) | `PostCompact`, reading the `compact_summary` field | Per the hooks reference, `PostCompact` supplies the generated compact summary directly in the hook input (field name `compact_summary`, confirmed 2026-09-20) -- no two-phase wait needed. |

Claude Code transcripts are parsed from the `transcript_path` JSONL file
supplied in the hook input (one JSON object per line; `tool_use` blocks are
paired with their `tool_result` by `tool_use_id`) into the same
`NormalizedToolCall[]` shape the OpenCode adapter builds from message parts,
so `core/compaction-plus/state.ts`'s `extractNexusState()` is identical
between adapters. This is still used by `PostCompact` to recover the Nexus
session ID for recording the compaction entry, and by `PreCompact` purely
for diagnostic logging (since injection isn't possible).

## Remaining unverified item

Interactive vs. headless (`claude -p`) hook behavior parity, per the
capability matrix disclosure. Add an integration test covering both modes
and pin a minimum Claude Code version before removing the `partial` label.

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

# nexus-core (Claude Code plugin)

**Marketplace:** `gatewarden-nexus` · **Plugin:** `nexus-core` · **Version:** `1.5.2`

The Claude Code distribution of this repo's runtime plugins
(`session-guard`, `headroom-intercept`, `compaction-plus`, `routing-guard`,
`cost-control`, and the Claude Code-only `agent-observer` and `dispatch-inbox`), packaged as a single installable Claude Code plugin,
plus four agents for
architecture/code/security/documentation review.

`600-attribution-headers` is intentionally excluded and has no
Claude Code adapter.

## Install

```
/plugin marketplace add gwnexus/nexus-runtime-plugins
/plugin install nexus-core@gatewarden-nexus
```

Or, for a specific pinned release:

```
/plugin marketplace add gwnexus/nexus-runtime-plugins --ref nexus-core--v1.0.0
/plugin install nexus-core@gatewarden-nexus
```

Set `NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` in your environment (or a
project-local `.nexus/config.toml` + `.nexus/credentials.toml`, or `.mcp.json`
`mcpServers.nexus.env` -- see `core/headroom-intercept/config.ts` for the
full resolution order) before enabling the plugin.

The API URL must use `https://`. Plain `http://` is accepted only for
loopback hosts (`localhost`, `127.0.0.0/8`, `::1`), so the private token is
never sent in clear text. A pinned URL that fails this check disables the
Nexus calls instead of falling back to another source.

A repository can set `api_url` in its own `.nexus/config.toml`. A token from
another source (environment, `.mcp.json`, `opencode.json`, global config) is
only sent to that URL when the operator approved the host. Approval comes
from `NEXUS_API_URL`, from the `api_url` of the global
`~/.config/nexus/config.toml`, or from a comma-separated list in
`NEXUS_TRUSTED_API_URLS`. A project linked with `nexus link` / `nexus pull`
(`config.toml` and `credentials.toml` together) needs no approval.

## Structure

```
plugins/nexus-core/
├── .claude-plugin/plugin.json   # plugin manifest
├── hooks/
│   ├── hooks.json                # event wiring for all 7 adapters
│   ├── session-guard.mjs         # GENERATED -- do not edit directly
│   ├── headroom-intercept.mjs    # GENERATED -- do not edit directly
│   ├── compaction-plus.mjs       # GENERATED -- do not edit directly
│   ├── routing-guard.mjs         # GENERATED -- do not edit directly
│   ├── cost-control.mjs          # GENERATED -- do not edit directly
│   ├── agent-observer.mjs        # GENERATED -- do not edit directly
│   └── dispatch-inbox.mjs        # GENERATED -- do not edit directly
├── schemas/
│   └── nexus.agent-observation.v1.schema.json   # record schema of observer/events.jsonl
└── agents/
    ├── architect.md
    ├── reviewer.md
    ├── security-reviewer.md
    └── documentation-reviewer.md
```

## Hook bundles are generated -- do not hand-edit

The `.mjs` files under `hooks/` are single-file ESM bundles built with
esbuild from the TypeScript sources in `adapters/claude-code/*/` and
`core/*/`. Plugins install via git, and Claude Code's `command`-type hooks
run the file directly with `node`, so TypeScript isn't executable in place
and the bundles must be committed.

After changing any Claude Code adapter or a `core/*` module it depends on,
regenerate the bundles and commit them in the same change:

```bash
npm run build:nexus-core-plugin
```

CI fails the build (`npm run verify:nexus-core-plugin`) if the committed
bundles have drifted from source.

## Agent observer

`agent-observer` writes one `nexus.agent-observation.v1` line per hook event
to `.nexus/claude/observer/events.jsonl` for `nexus status --agents`. It is
registered on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure` (matcher `*` for the tool events), `Notification`,
`SubagentStart`, `SubagentStop`, `Stop`, `StopFailure` and `SessionEnd`.
Consumers validate against `schemas/nexus.agent-observation.v1.schema.json`.
See `adapters/claude-code/agent-observer/README.md` for the derivation rules,
guarantees and known gaps.

## Dispatch inbox

`dispatch-inbox` connects running sessions to the Nexus CLI's Dispatch
runner (`nexus dispatch listen`). On `SessionStart` it registers the session
in `~/.config/nexus/state/dispatch/sessions/<session_id>.json` (socket and
messaging token of Claude Code's cross-session inbox, mode 0600). The runner
then pushes short Dispatch notices into the running session. On `SessionStart`
it also adds notices queued while no session ran as context, once each. On
`SessionEnd` it removes the session file. See
`adapters/claude-code/dispatch-inbox/README.md`.

## Agents

The four agents (`architect`, `reviewer`, `security-reviewer`,
`documentation-reviewer`) are general-purpose review engines -- they do not
depend on the Nexus MCP server and work the same whether or not Nexus hooks
are enabled. Each agent carries its review checklist inline. Their names are
stable: project skills may run them internally.

Since 1.2.0 the plugin ships no workflow skills. Workflows that read or
write Nexus artifacts (reviews, ADRs, plans) belong to the project's own
`/nexus-*` skills, so there is a single path to each job.

## Versioning and releases

Use `claude plugin tag` (Claude Code 2.1.281+) to cut a release -- it creates
a `{name}--v{version}` tag (`nexus-core--vX.Y.Z`, matching `plugin.json`'s
`version` field) and validates `plugin.json` against the marketplace entry
before tagging. Do not hand-create tags in a different format; the Nexus platform
pins `extraKnownMarketplaces.gatewarden-nexus.source.ref` to this exact tag
format. Users can pin an install to a specific release the same way:
`/plugin marketplace add gwnexus/nexus-runtime-plugins --ref nexus-core--vX.Y.Z`.
Record every user-visible change in `../../CHANGELOG.md` under the
`nexus-core` heading before tagging.

## Known gaps (disclosed, not silently assumed away)

- `nexus_headroom_intercept_retrieve` is not available as a Claude Code
  tool (no custom-tool-registration hook exists in Claude Code) -- see
  `adapters/claude-code/headroom-intercept/README.md`.
- `nexus_cost_summary` (on-demand cost snapshot) has no Claude Code
  equivalent for the same reason -- see
  `adapters/claude-code/cost-control/README.md`.
- Continuous mid-session routing validation (OpenCode's
  `experimental.chat.system.transform`) has no Claude Code equivalent;
  `routing-guard` only validates at `SessionStart`.

# nexus-core (Claude Code plugin)

**Marketplace:** `gatewarden-nexus` · **Plugin:** `nexus-core` · **Version:** `1.0.0`

The Claude Code distribution of this repo's five in-scope runtime plugins
(`session-guard`, `headroom-intercept`, `compaction-plus`, `routing-guard`,
`cost-control`), packaged as a single installable Claude Code plugin per
ADR-0117 (nexus-app, accepted), plus a starter set of skills and agents for
architecture/code/security/documentation review and implementation planning.

`600-attribution-headers` is intentionally excluded (ADR-C08) and has no
Claude Code adapter.

## Install

```
/plugin marketplace add gwnexus/nexus-runtime-plugins
/plugin install nexus-core@gatewarden-nexus
```

Or, for a specific pinned release:

```
/plugin marketplace add gwnexus/nexus-runtime-plugins --ref nexus-core-v1.0.0
/plugin install nexus-core@gatewarden-nexus
```

Set `NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` in your environment (or a
project-local `.nexus/config.toml` + `.nexus/credentials.toml`, or `.mcp.json`
`mcpServers.nexus.env` -- see `core/headroom-intercept/config.ts` for the
full resolution order) before enabling the plugin.

## Structure

```
plugins/nexus-core/
├── .claude-plugin/plugin.json   # plugin manifest
├── hooks/
│   ├── hooks.json                # event wiring for all 5 adapters
│   ├── session-guard.mjs         # GENERATED -- do not edit directly
│   ├── headroom-intercept.mjs    # GENERATED -- do not edit directly
│   ├── compaction-plus.mjs       # GENERATED -- do not edit directly
│   ├── routing-guard.mjs         # GENERATED -- do not edit directly
│   └── cost-control.mjs          # GENERATED -- do not edit directly
├── skills/
│   ├── adr-review/
│   ├── architecture-review/
│   ├── code-review/
│   ├── documentation-review/
│   ├── implementation-plan/
│   └── test-ops/
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

## Skills and agents

The six skills (`adr-review`, `architecture-review`, `code-review`,
`documentation-review`, `implementation-plan`, `test-ops`) and four agents
(`architect`, `reviewer`, `security-reviewer`, `documentation-reviewer`) are
general-purpose software engineering skills -- they do not depend on the
Nexus MCP server and work the same whether or not Nexus hooks are enabled.
They are a starting point (per the originating dispatch, "content can start
from the existing Nexus skills") and are expected to evolve independently of
the hook bundles.

## Versioning and releases

Tag releases as `nexus-core-vX.Y.Z` (immutable, matching
`plugin.json`'s `version` field) so users can pin
`/plugin marketplace add ... --ref nexus-core-vX.Y.Z` to an exact release
instead of tracking `main`. Record every user-visible change in
`../../CHANGELOG.md` under the `nexus-core` heading.

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

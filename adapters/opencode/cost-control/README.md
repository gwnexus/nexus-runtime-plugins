# nexus-cost-control (OpenCode adapter)

An [OpenCode](https://opencode.ai) plugin that surfaces token usage and cost
visibility inside [Nexus](https://nexus.gatewarden.eu) sessions.

**Current version:** `v1.2.0`  
**Tracking mechanism:** native OpenCode message-data aggregation (zero-config, primary), with optional [Helicone](https://helicone.ai) enrichment  
**Requires:** `NEXUS_API_URL`, `NEXUS_PRIVATE_TOKEN` (`HELICONE_API_KEY` is optional)

> **Precedence (per ADR-0040, nexus-app):** native token-usage aggregation
> from OpenCode's own message data is the default, always-on,
> zero-configuration path. Helicone is opt-in enrichment: if
> `HELICONE_API_KEY` is configured, it is queried in addition and its
> result (with a real metered `cost_usd`) is preferred when it returns
> data. Earlier `v1.1.0` inverted this (gated everything on Helicone being
> configured, with native aggregation only as a fallback for empty
> Helicone responses) -- a drift from ADR-0040 introduced during the
> ADR-C05 core/adapters restructure, corrected in `v1.2.0` per Dispatch
> `6298a740`.

> Migrated to the ADR-C05 `core/` + `adapters/` structure (Track B2, the
> last plugin in this restructure pass). Credential resolution, state
> extraction, the Helicone client, formatting, and the Nexus API call now
> live in [`core/cost-control/`](../../../core/cost-control), shared with
> the [Claude Code adapter](../../claude-code/cost-control). This file
> documents the OpenCode-specific wiring (message/part parsing, `session.idle`
> hook, tool registration).

## What this plugin does

1. **Session grouping (optional, Helicone only)**: if configured, injects
   the active Nexus session ID as a `Helicone-Session-Id` property so every
   LLM call in a Nexus session is grouped and queryable together in the
   Helicone dashboard.
2. **Automatic usage recording**: on `session.idle` (agent finishes a work
   burst), aggregates token counts directly from OpenCode's own message
   data (`AssistantMessage.tokens`) -- no external service required -- and
   appends a structured summary to the Nexus session timeline.
3. **Helicone enrichment (optional)**: if `HELICONE_API_KEY` is configured,
   the plugin also queries Helicone for the session; if Helicone has data,
   its result (with a real metered `cost_usd`, latency, etc.) is recorded
   instead of the native token-only entry.
4. **On-demand cost tool**: exposes `nexus_cost_summary` so the agent can pull
   a live usage/cost snapshot at any time during a session.
5. **`cost_source` field**: every recorded entry carries `cost_source:
   "runtime"` (native aggregation, `cost_usd: null`) or `cost_source:
   "helicone"` (metered, `cost_usd` is a real dollar figure), so downstream
   consumers can tell the two apart without inferring it from a missing
   field. See Dispatch `515186c1` and `6298a740`.

## How Helicone enrichment works (optional)

Helicone sits as a transparent proxy between your agent and the LLM provider
(Anthropic, OpenAI, etc.). Every LLM call is recorded with:

- Input / output / cache token counts
- Estimated cost in USD (using published model pricing)
- Latency and model name
- Custom session/property headers for grouping

This is entirely optional. Without it, the plugin still records token usage
via native OpenCode message data -- `cost_usd` will be `null` in that case
since no external service has computed a metered dollar figure.

Route requests through Helicone by changing the provider base URL:

| Provider  | Original                     | Via Helicone                        |
| --------- | ---------------------------- | ----------------------------------- |
| Anthropic | `https://api.anthropic.com`  | `https://anthropic.helicone.ai`     |
| OpenAI    | `https://api.openai.com`     | `https://oai.helicone.ai`           |

## Installation

```bash
# Copy into your project's OpenCode plugins directory
cp nexus-cost-control.ts /path/to/your-project/.opencode/plugins/
```

Ensure `.opencode/package.json` includes the plugin SDK:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

## Configuration

### 1. Set environment variables (Helicone key is optional)

```bash
export NEXUS_API_URL="https://nexus.gatewarden.eu"
export NEXUS_PRIVATE_TOKEN="nxs_pat_..."

# Optional: enables Helicone enrichment (metered cost_usd, latency, dashboard)
export HELICONE_API_KEY="sk-helicone-..."
```

`HELICONE_API_KEY` can also be stored in `~/.config/nexus/config.toml`:

```toml
helicone_api_key = "sk-helicone-..."
```

### 2. Route requests through Helicone (optional, only if you want enrichment)

In your `opencode.json`, change the provider base URL and add the session
header. Example for Anthropic:

```json
{
  "provider": {
    "anthropic": {
      "baseURL": "https://anthropic.helicone.ai",
      "options": {
        "defaultHeaders": {
          "Helicone-Auth": "Bearer sk-helicone-...",
          "Helicone-Session-Id": "${NEXUS_SESSION_ID}"
        }
      }
    }
  }
}
```

> The `nexus-compaction-plus` plugin exposes the active Nexus session ID via
> the `NEXUS_SESSION_ID` convention. When both plugins are loaded, session
> grouping works automatically.

### 3. Nexus MCP server (required for timeline recording)

```json
{
  "mcp": {
    "nexus": {
      "type": "local",
      "command": ["npx", "--yes", "@gwdn/nexus-mcp@latest"],
      "environment": {
        "NEXUS_API_URL": "https://nexus.gatewarden.eu",
        "NEXUS_PRIVATE_TOKEN": "nxs_pat_..."
      }
    }
  }
}
```

## How it works

### `session.idle` → usage/cost recording

When the agent finishes a work burst and goes idle, the plugin:

1. Fetches the active OpenCode session messages
2. Extracts the Nexus session ID from tool call history
3. Aggregates token counts from OpenCode's native message data
   (`AssistantMessage.tokens`) -- always, with no external dependency
4. If `HELICONE_API_KEY` is configured, also queries Helicone; if it
   returns data, that metered entry (`cost_source: "helicone"`) is recorded
   instead of the native one
5. Appends a structured markdown table to the Nexus session via the MCP API

Recording is debounced — at most once every 5 minutes — to avoid spamming the
timeline during rapid back-and-forth sessions.

If no assistant messages exist and Helicone has no data either, no entry is
written (nothing to report).

### `nexus_cost_summary` tool

The agent can call this at any time to get a live usage/cost snapshot, with
no configuration required:

```
## Token & Cost Summary — 14:32

Tracked via runtime token counts (no Helicone data for this session — subscription/direct-provider lane) · nexus-cost-control v1.2.0

| Metric              | Value        |
|---------------------|--------------|
| Assistant messages  | 47           |
| Input tokens        | 124,500      |
| Output tokens       | 32,100       |
| Cache read tokens   | 80,000       |
| Cache write tokens  | 44,500       |
| Total tokens        | 156,600      |
| Estimated cost      | n/a (subscription — not metered) |
| Models              | claude-opus-4|
```

If Helicone is configured and returns data for the session, the summary
instead shows `Tracked via [Helicone](https://helicone.ai)`, a `Requests`
row, and a real `$` cost figure.

## Testing

```bash
npm test -- adapters/opencode/cost-control core/cost-control
```

9 unit tests for this adapter (hook registration, tool output, event
routing, zero-config native recording, Helicone-enrichment precedence),
plus 19 unit tests for the shared core modules (state extraction, config
resolution, Helicone client, formatting, runtime-usage aggregation, API
call).

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

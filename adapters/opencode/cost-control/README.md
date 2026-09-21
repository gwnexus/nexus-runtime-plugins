# nexus-cost-control (OpenCode adapter)

An [OpenCode](https://opencode.ai) plugin that surfaces token usage and cost
visibility inside [Nexus](https://nexus.gatewarden.eu) sessions.

**Current version:** `v1.1.0`  
**Tracking mechanism:** [Helicone](https://helicone.ai) LLM observability proxy  
**Requires:** `HELICONE_API_KEY`, `NEXUS_API_URL`, `NEXUS_PRIVATE_TOKEN`

> **Roadmap — v2.0.0:** A rewrite is planned that reads cost data directly from
> OpenCode native message data as the primary source, removing the Helicone
> dependency entirely. As of v1.1.0, native OpenCode message data (token
> counts only, no cost) is already used as a fallback when Helicone has no
> record of a session — see "Runtime fallback" below.

> Migrated to the ADR-C05 `core/` + `adapters/` structure (Track B2, the
> last plugin in this restructure pass). Credential resolution, state
> extraction, the Helicone client, formatting, and the Nexus API call now
> live in [`core/cost-control/`](../../../core/cost-control), shared with
> the [Claude Code adapter](../../claude-code/cost-control). This file
> documents the OpenCode-specific wiring (message/part parsing, `session.idle`
> hook, tool registration).

## What this plugin does

The plugin connects [Helicone](https://helicone.ai) — an LLM observability
proxy that records every provider request — to the Nexus session timeline.

1. **Session grouping**: injects the active Nexus session ID as a
   `Helicone-Session-Id` property so every LLM call in a Nexus session is
   grouped and queryable together in the Helicone dashboard.
2. **Automatic cost recording**: on `session.idle` (agent finishes a work
   burst), queries the Helicone API for cumulative token and cost data and
   appends a structured summary to the Nexus session timeline.
3. **On-demand cost tool**: exposes `nexus_cost_summary` so the agent can pull
   a live cost snapshot at any time during a session.
4. **Runtime fallback (`cost_source: "runtime"`)**: if Helicone is
   configured but has no data for the session (subscription/direct-provider
   lanes that never pass through the Helicone proxy), the plugin falls back
   to aggregating token counts directly from OpenCode's own message data
   (`AssistantMessage.tokens`). The recorded entry has `cost_usd: null`
   (never `0`) and `cost_source: "runtime"`, so downstream consumers can
   tell a metered entry from a token-only one. See Dispatch `515186c1`.

## How Helicone works

Helicone sits as a transparent proxy between your agent and the LLM provider
(Anthropic, OpenAI, etc.). Every LLM call is recorded with:

- Input / output / cache token counts
- Estimated cost in USD (using published model pricing)
- Latency and model name
- Custom session/property headers for grouping

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

### 1. Set environment variables

```bash
export HELICONE_API_KEY="sk-helicone-..."
export NEXUS_API_URL="https://nexus.gatewarden.eu"
export NEXUS_PRIVATE_TOKEN="nxs_pat_..."
```

`HELICONE_API_KEY` can also be stored in `~/.config/nexus/config.toml`:

```toml
helicone_api_key = "sk-helicone-..."
```

### 2. Route requests through Helicone

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

### `session.idle` → cost recording

When the agent finishes a work burst and goes idle, the plugin:

1. Fetches the active OpenCode session messages
2. Extracts the Nexus session ID from tool call history
3. Queries Helicone for all requests tagged with that session ID
4. Aggregates token counts and cost across all matched requests
5. Appends a structured markdown table to the Nexus session via the MCP API

Recording is debounced — at most once every 5 minutes — to avoid spamming the
timeline during rapid back-and-forth sessions.

If Helicone returns no data for the session, the plugin aggregates token
counts from OpenCode's native message data instead (`cost_source: "runtime"`,
`cost_usd: null`) rather than skipping the entry outright. If no assistant
messages are found either, no entry is written.

### `nexus_cost_summary` tool

The agent can call this at any time to get a live cost snapshot:

```
## Token & Cost Summary — 14:32

Tracked via Helicone · nexus-cost-control v1.1.0

| Metric              | Value        |
|---------------------|--------------|
| Requests            | 47           |
| Input tokens        | 124,500      |
| Output tokens       | 32,100       |
| Cache read tokens   | 80,000       |
| Cache write tokens  | 44,500       |
| Total tokens        | 156,600      |
| Estimated cost      | $0.084200    |
| Models              | claude-opus-4|
```

## Testing

```bash
npm test -- adapters/opencode/cost-control core/cost-control
```

8 unit tests for this adapter (hook registration, tool output, event
routing, config handling, runtime-fallback recording), plus 19 unit tests
for the shared core modules (state extraction, config resolution, Helicone
client, formatting, runtime-usage aggregation, API call).

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../../../LICENSE).

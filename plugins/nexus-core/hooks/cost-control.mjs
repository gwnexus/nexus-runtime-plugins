#!/usr/bin/env node
// GENERATED FILE -- do not edit directly. Built from adapters/claude-code/cost-control/nexus-cost-control.ts by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.

// adapters/claude-code/cost-control/nexus-cost-control.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "node:fs";

// core/logger.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
function createFileLogger(directory, logFileName) {
  let logDir = null;
  return (level, message) => {
    try {
      if (!logDir) {
        logDir = join(directory, ".nexus");
        mkdirSync(logDir, { recursive: true });
      }
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}
`;
      appendFileSync(join(logDir, logFileName), line);
    } catch {
    }
  };
}

// core/state-store.ts
import { readFileSync, writeFileSync, mkdirSync as mkdirSync2, existsSync } from "node:fs";
import { join as join2 } from "node:path";
function loadState(directory, fileName, fallback) {
  try {
    const path = join2(directory, ".nexus", fileName);
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (isPlainObject(fallback) && isPlainObject(parsed)) {
      return { ...fallback, ...parsed };
    }
    return parsed;
  } catch {
    return fallback;
  }
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function saveState(directory, fileName, state) {
  try {
    const dir = join2(directory, ".nexus");
    mkdirSync2(dir, { recursive: true });
    writeFileSync(join2(dir, fileName), JSON.stringify(state, null, 2));
  } catch {
  }
}

// core/cost-control/config.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
function getNexusConfig(_directory) {
  const apiUrl = process.env.NEXUS_API_URL;
  const token = process.env.NEXUS_PRIVATE_TOKEN;
  if (apiUrl && token) return { apiUrl, token };
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const nexusConfigDir = join3(home, ".config", "nexus");
    let resolvedApiUrl;
    try {
      const raw = readFileSync2(join3(nexusConfigDir, "config.toml"), "utf-8");
      const m = raw.match(/^\s*api_url\s*=\s*"([^"]+)"/m);
      if (m) resolvedApiUrl = m[1];
    } catch {
    }
    let resolvedToken;
    try {
      const raw = readFileSync2(join3(nexusConfigDir, "credentials.toml"), "utf-8");
      const m = raw.match(/^\s*token\s*=\s*"([^"]+)"/m);
      if (m) resolvedToken = m[1];
    } catch {
    }
    if (resolvedApiUrl && resolvedToken) {
      return { apiUrl: resolvedApiUrl, token: resolvedToken };
    }
  } catch {
  }
  return null;
}
function getHeliconeConfig(_directory) {
  const apiKey = process.env.HELICONE_API_KEY;
  if (apiKey) return { apiKey };
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const configPath = join3(home, ".config", "nexus", "config.toml");
    const raw = readFileSync2(configPath, "utf-8");
    const m = raw.match(/^\s*helicone_api_key\s*=\s*"([^"]+)"/m);
    if (m) return { apiKey: m[1] };
  } catch {
  }
  return null;
}

// core/cost-control/state.ts
function extractNexusState(calls, onDebug) {
  const state = {};
  for (const call of calls) {
    const { tool: toolName, args, result } = call;
    if (!toolName) continue;
    if (toolName === "nexus_session_create") {
      if (args.project_id) state.projectId = String(args.project_id);
      if (args.agent_id) state.agentId = String(args.agent_id);
      if (result?.id) state.sessionId = String(result.id);
      if (result?.session_id) state.sessionId = String(result.session_id);
    }
    if (toolName === "nexus_session_append" && args.session_id) {
      state.sessionId = String(args.session_id);
    }
    if (toolName.startsWith("nexus_") && args.project_id && !state.projectId) {
      state.projectId = String(args.project_id);
    }
    if (toolName !== "nexus_session_create" && result) {
      if (result.session_id) state.sessionId = String(result.session_id);
    }
  }
  onDebug?.(`extractNexusState: ${JSON.stringify(state)}`);
  return state;
}

// core/cost-control/helicone.ts
async function queryHeliconeSession(heliconeConfig, nexusSessionId, onLog) {
  const url = "https://api.helicone.ai/v1/request/query";
  const payload = {
    filter: {
      request: {
        properties: {
          "Helicone-Session-Id": { equals: nexusSessionId }
        }
      }
    },
    limit: 1e3,
    offset: 0,
    sort: { created_at: "desc" }
  };
  onLog?.("info", `Querying Helicone for session ${nexusSessionId}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${heliconeConfig.apiKey}`
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      onLog?.("error", `Helicone API ${res.status}: ${body}`);
      return null;
    }
    const data = await res.json();
    const requests = data.data ?? [];
    onLog?.("info", `Helicone returned ${requests.length} requests for session`);
    if (requests.length === 0) return null;
    let tokensInput = 0;
    let tokensOutput = 0;
    let tokensCacheRead = 0;
    let tokensCacheWrite = 0;
    let costUsd = 0;
    const modelsSet = /* @__PURE__ */ new Set();
    for (const req of requests) {
      const r = req.request;
      if (!r) continue;
      tokensInput += r.prompt_tokens ?? 0;
      tokensOutput += r.completion_tokens ?? 0;
      tokensCacheRead += r.prompt_cache_read_tokens ?? 0;
      tokensCacheWrite += r.prompt_cache_write_tokens ?? 0;
      costUsd += r.helicone_cost ?? 0;
      if (r.model) modelsSet.add(r.model);
    }
    return {
      nexusSessionId,
      totalRequests: requests.length,
      tokensInput,
      tokensOutput,
      tokensCacheRead,
      tokensCacheWrite,
      totalTokens: tokensInput + tokensOutput,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      // 6 decimal places
      costSource: "helicone",
      models: Array.from(modelsSet),
      queriedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch (err) {
    onLog?.("error", `Helicone query failed: ${err}`);
    return null;
  }
}

// core/cost-control/format.ts
function formatCostSummary(cost, pluginVersion) {
  const time = (/* @__PURE__ */ new Date()).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const isRuntimeSourced = cost.costSource === "runtime";
  const source = isRuntimeSourced ? "runtime token counts (no Helicone data for this session \u2014 subscription/direct-provider lane)" : "[Helicone](https://helicone.ai)";
  const lines = [
    `## Token & Cost Summary \u2014 ${time}`,
    ``,
    `Tracked via ${source} \xB7 nexus-cost-control v${pluginVersion}`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`
  ];
  if (isRuntimeSourced) {
    lines.push(`| Assistant messages | ${(cost.totalMessages ?? 0).toLocaleString()} |`);
  } else {
    lines.push(`| Requests | ${cost.totalRequests} |`);
  }
  lines.push(
    `| Input tokens | ${cost.tokensInput.toLocaleString()} |`,
    `| Output tokens | ${cost.tokensOutput.toLocaleString()} |`,
    `| Cache read tokens | ${cost.tokensCacheRead.toLocaleString()} |`,
    `| Cache write tokens | ${cost.tokensCacheWrite.toLocaleString()} |`,
    `| **Total tokens** | **${cost.totalTokens.toLocaleString()}** |`,
    `| **Estimated cost** | **${cost.costUsd === null ? "n/a (subscription \u2014 not metered)" : `$${cost.costUsd.toFixed(6)}`}** |`
  );
  if (cost.models.length > 0) {
    lines.push(`| Models | ${cost.models.join(", ")} |`);
  }
  return lines.join("\n");
}

// core/cost-control/api.ts
async function appendCostEntry(nexusConfig, sessionId, cost, pluginMeta, onLog) {
  const url = `${nexusConfig.apiUrl}/api/mcp/sessions`;
  const summary = formatCostSummary(cost, pluginMeta.version);
  const payload = {
    action: "session_append",
    session_id: sessionId,
    entry_type: "cost_snapshot",
    summary,
    metadata: JSON.stringify({
      plugin: pluginMeta.name,
      plugin_version: pluginMeta.version,
      tokens_input: cost.tokensInput,
      tokens_output: cost.tokensOutput,
      tokens_cache_read: cost.tokensCacheRead,
      tokens_cache_write: cost.tokensCacheWrite,
      total_tokens: cost.totalTokens,
      total_messages: cost.totalMessages ?? null,
      cost_usd: cost.costUsd,
      cost_source: cost.costSource ?? "helicone",
      total_requests: cost.totalRequests,
      models: cost.models,
      helicone_session_id: cost.nexusSessionId
    })
  };
  onLog?.("info", `Appending cost entry to Nexus session ${sessionId}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${nexusConfig.token}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.text().catch(() => "");
  onLog?.("info", `Response ${res.status}: ${body.substring(0, 200)}`);
  if (!res.ok) {
    throw new Error(`Nexus API ${res.status}: ${body}`);
  }
}

// core/cost-control/runtime-usage.ts
function emptyRuntimeUsage() {
  return {
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    totalTokens: 0,
    totalMessages: 0,
    models: []
  };
}
function buildRuntimeCostEntry(nexusSessionId, usage) {
  return {
    nexusSessionId,
    totalRequests: 0,
    tokensInput: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    tokensCacheRead: usage.tokensCacheRead,
    tokensCacheWrite: usage.tokensCacheWrite,
    totalTokens: usage.totalTokens,
    costUsd: null,
    costSource: "runtime",
    models: usage.models,
    totalMessages: usage.totalMessages,
    queriedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// adapters/claude-code/cost-control/nexus-cost-control.ts
var PLUGIN_META = { name: "nexus-cost-control", version: "1.2.0" };
var STATE_FILE = "cost-control-state.json";
function initialState() {
  return { lastAppendAt: null, lastAppendedTokens: null };
}
function parseClaudeTranscript(transcriptPath) {
  const calls = [];
  if (!existsSync2(transcriptPath)) return calls;
  let raw;
  try {
    raw = readFileSync3(transcriptPath, "utf-8");
  } catch {
    return calls;
  }
  const pendingById = /* @__PURE__ */ new Map();
  const resultById = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        pendingById.set(block.id, { tool: block.name, args: block.input ?? {} });
      }
      if (block?.type === "tool_result" && block.tool_use_id) {
        const text = Array.isArray(block.content) ? block.content.find((c) => c?.type === "text")?.text : typeof block.content === "string" ? block.content : void 0;
        let parsed = null;
        if (typeof text === "string") {
          try {
            const j = JSON.parse(text);
            if (typeof j === "object" && j !== null) parsed = j;
          } catch {
          }
        }
        resultById.set(block.tool_use_id, parsed);
      }
    }
  }
  for (const [id, pending] of pendingById) {
    calls.push({ tool: pending.tool, args: pending.args, result: resultById.get(id) ?? null });
  }
  return calls;
}
var IDLE_DEBOUNCE_MS = 5 * 60 * 1e3;
function aggregateClaudeUsage(transcriptPath) {
  const usage = emptyRuntimeUsage();
  if (!existsSync2(transcriptPath)) return usage;
  let raw;
  try {
    raw = readFileSync3(transcriptPath, "utf-8");
  } catch {
    return usage;
  }
  const modelsSet = /* @__PURE__ */ new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (!message || message.role !== "assistant") continue;
    usage.totalMessages += 1;
    const u = message.usage;
    if (u) {
      usage.tokensInput += u.input_tokens ?? 0;
      usage.tokensOutput += u.output_tokens ?? 0;
      usage.tokensCacheRead += u.cache_read_input_tokens ?? 0;
      usage.tokensCacheWrite += u.cache_creation_input_tokens ?? 0;
    }
    if (message.model) modelsSet.add(message.model);
  }
  usage.totalTokens = usage.tokensInput + usage.tokensOutput;
  usage.models = Array.from(modelsSet);
  return usage;
}
async function handleStop(input, logger) {
  const directory = input.cwd ?? process.cwd();
  const nexusConfig = getNexusConfig(directory);
  const heliconeConfig = getHeliconeConfig(directory);
  if (!nexusConfig) {
    logger("debug", "Stop \u2014 skipping (Nexus config not present)");
    return;
  }
  const state = loadState(directory, STATE_FILE, initialState());
  if (state.lastAppendAt && Date.now() - state.lastAppendAt < IDLE_DEBOUNCE_MS) {
    logger("debug", `Stop \u2014 skipping (last append ${Date.now() - state.lastAppendAt}ms ago)`);
    return;
  }
  if (!input.transcript_path) {
    logger("warn", "Stop \u2014 no transcript_path in hook input, skipping");
    return;
  }
  const calls = parseClaudeTranscript(input.transcript_path);
  const nexusState = extractNexusState(calls, (m) => logger("debug", m));
  if (!nexusState.sessionId) {
    logger("info", "No Nexus session ID found \u2014 skipping cost recording");
    return;
  }
  const cost = heliconeConfig ? await queryHeliconeSession(heliconeConfig, nexusState.sessionId, (level, msg) => logger(level, msg)) : null;
  let entry = cost;
  if (!entry) {
    const usage = aggregateClaudeUsage(input.transcript_path);
    if (usage.totalMessages === 0) {
      logger("info", `No usage data for session ${nexusState.sessionId} \u2014 skipping`);
      return;
    }
    entry = buildRuntimeCostEntry(nexusState.sessionId, usage);
    logger(
      "info",
      `Recording native token aggregation for session ${nexusState.sessionId} (cost_source=runtime${heliconeConfig ? ", Helicone configured but returned no data" : ""})`
    );
  }
  if (state.lastAppendedTokens !== null && entry.totalTokens === state.lastAppendedTokens) {
    logger("debug", `Stop \u2014 skipping (no token delta, still ${entry.totalTokens})`);
    return;
  }
  try {
    await appendCostEntry(nexusConfig, nexusState.sessionId, entry, PLUGIN_META, (level, msg) => logger(level, msg));
    state.lastAppendAt = Date.now();
    state.lastAppendedTokens = entry.totalTokens;
    saveState(directory, STATE_FILE, state);
    const costLabel = entry.costUsd === null ? "n/a (runtime)" : `$${entry.costUsd.toFixed(6)}`;
    logger("info", `Cost entry recorded \u2014 ${costLabel} / ${entry.totalTokens} tokens`);
  } catch (err) {
    logger("error", `Failed to record cost entry: ${err}`);
  }
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
async function main() {
  const mode = process.argv[2] ?? "";
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const directory = input.cwd ?? process.cwd();
  const fileLog = createFileLogger(directory, "cost-control.log");
  const logger = (level, message) => fileLog(level, message);
  if (mode === "stop") {
    await handleStop(input, logger);
    process.exit(0);
  }
  fileLog("warn", `Unknown mode "${mode}" (expected stop) \u2014 no-op`);
  process.exit(0);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}
`);
    process.exit(0);
  });
}
export {
  aggregateClaudeUsage,
  handleStop,
  parseClaudeTranscript
};

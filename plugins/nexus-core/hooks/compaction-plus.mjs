#!/usr/bin/env node
// GENERATED FILE -- do not edit directly. Built from adapters/claude-code/compaction-plus/nexus-compaction-plus.ts by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.

// adapters/claude-code/compaction-plus/nexus-compaction-plus.ts
import { readFileSync as readFileSync2, existsSync } from "node:fs";

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

// core/compaction-plus/config.ts
import { readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function getNexusConfig(_directory) {
  const apiUrl = process.env.NEXUS_API_URL;
  const token = process.env.NEXUS_PRIVATE_TOKEN;
  if (apiUrl && token) return { apiUrl, token };
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const nexusConfigDir = join2(home, ".config", "nexus");
    let resolvedApiUrl;
    try {
      const configRaw = readFileSync(join2(nexusConfigDir, "config.toml"), "utf-8");
      const apiMatch = configRaw.match(/^\s*api_url\s*=\s*"([^"]+)"/m);
      if (apiMatch) resolvedApiUrl = apiMatch[1];
    } catch {
    }
    let resolvedToken;
    try {
      const credsRaw = readFileSync(join2(nexusConfigDir, "credentials.toml"), "utf-8");
      const tokenMatch = credsRaw.match(/^\s*token\s*=\s*"([^"]+)"/m);
      if (tokenMatch) resolvedToken = tokenMatch[1];
    } catch {
    }
    if (resolvedApiUrl && resolvedToken) {
      return { apiUrl: resolvedApiUrl, token: resolvedToken };
    }
  } catch {
  }
  return null;
}

// core/compaction-plus/state.ts
function extractNexusState(calls, onDebug) {
  const state = {};
  for (const call of calls) {
    const { tool: toolName, args, result } = call;
    if (!toolName) continue;
    if (toolName === "nexus_session_create") {
      if (args.project_id) state.projectId = String(args.project_id);
      if (args.agent_id) state.agentId = String(args.agent_id);
      if (result) {
        onDebug?.(`nexus_session_create result keys: ${JSON.stringify(Object.keys(result))}`);
        if (result.id) {
          state.sessionId = String(result.id);
          onDebug?.(`Captured session ID from session_create result.id: ${state.sessionId}`);
        }
        if (result.session_id) {
          state.sessionId = String(result.session_id);
          onDebug?.(`Captured session ID from session_create result.session_id: ${state.sessionId}`);
        }
        if (result.title) state.sessionTitle = String(result.title);
      }
    }
    if (toolName === "nexus_session_append" && args.session_id) {
      state.sessionId = String(args.session_id);
      onDebug?.(`Captured session ID from session_append args: ${state.sessionId}`);
    }
    if (toolName.startsWith("nexus_") && args.project_id && !state.projectId) {
      state.projectId = String(args.project_id);
    }
    if (toolName !== "nexus_session_create" && result) {
      if (result.session_id) state.sessionId = String(result.session_id);
      if (result.title) state.sessionTitle = String(result.title);
    }
  }
  onDebug?.(`extractNexusState result: ${JSON.stringify(state)}`);
  return state;
}
function cleanCompactedText(text) {
  let out = text.replace(/^(\s*---\s*\n?)+/, "").trimStart();
  out = out.replace(/^(#{2,6})\s/gm, (_match, hashes) => {
    const newLevel = Math.min(hashes.length + 2, 6);
    return "#".repeat(newLevel) + " ";
  });
  return out;
}
function buildCompactionSummary(pluginVersion, timeLabel, compactedText) {
  return compactedText ? `## Compaction at ${timeLabel}

Context preserved via nexus-compaction-plus v${pluginVersion}.

### Agent Summary

${compactedText}` : `## Compaction at ${timeLabel}

Context preserved via nexus-compaction-plus v${pluginVersion}.`;
}

// core/compaction-plus/api.ts
async function appendCompactionEntry(config, sessionId, summary, onLog) {
  const url = `${config.apiUrl}/api/mcp/sessions`;
  const payload = {
    action: "session_append",
    session_id: sessionId,
    entry_type: "compaction",
    summary
  };
  onLog?.("info", `POST ${url} \u2014 payload: ${JSON.stringify(payload)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.text().catch(() => "");
  onLog?.("info", `Response ${res.status}: ${body}`);
  if (!res.ok) {
    throw new Error(`Nexus API ${res.status}: ${body}`);
  }
}

// adapters/claude-code/compaction-plus/nexus-compaction-plus.ts
var PLUGIN_META = { name: "nexus-compaction-plus", version: "1.8.1" };
function parseClaudeTranscript(transcriptPath) {
  const calls = [];
  if (!existsSync(transcriptPath)) return calls;
  let raw;
  try {
    raw = readFileSync2(transcriptPath, "utf-8");
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
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
function handlePreCompact(input, logger) {
  if (!input.transcript_path) {
    logger("debug", "pre-compact: no transcript_path in hook input");
    return null;
  }
  const calls = parseClaudeTranscript(input.transcript_path);
  const state = extractNexusState(calls, (m) => logger("debug", m));
  if (!state.sessionId && !state.projectId) {
    logger("debug", "No Nexus session/project detected in pre-compact transcript");
  } else {
    logger(
      "info",
      `Pre-compact: detected session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"} (not injectable \u2014 PreCompact does not support additionalContext, logged for diagnostics only)`
    );
  }
  return null;
}
async function handlePostCompact(input, logger) {
  const directory = input.cwd ?? process.cwd();
  const nexusConfig = getNexusConfig(directory);
  if (!nexusConfig) {
    logger("warn", "No Nexus config \u2014 skipping post-compact recording");
    return;
  }
  let state = {};
  if (input.transcript_path) {
    const calls = parseClaudeTranscript(input.transcript_path);
    state = extractNexusState(calls, (m) => logger("debug", m));
  }
  if (!state.sessionId) {
    logger("warn", "No Nexus session ID found \u2014 skipping compaction entry");
    return;
  }
  const time = (/* @__PURE__ */ new Date()).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const compactedText = cleanCompactedText(input.compact_summary ?? "");
  const summary = buildCompactionSummary(PLUGIN_META.version, time, compactedText);
  try {
    await appendCompactionEntry(nexusConfig, state.sessionId, summary, (level, msg) => logger(level, msg));
    logger("info", `Compaction entry recorded in Nexus session ${state.sessionId}`);
  } catch (err) {
    logger("error", `Failed to record compaction entry: ${err}`);
  }
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
  const fileLog = createFileLogger(directory, "compaction-plus.log");
  const logger = (level, message) => fileLog(level, message);
  if (mode === "pre-compact") {
    handlePreCompact(input, logger);
    process.exit(0);
  }
  if (mode === "post-compact") {
    await handlePostCompact(input, logger);
    process.exit(0);
  }
  fileLog("warn", `Unknown mode "${mode}" (expected pre-compact|post-compact) \u2014 no-op`);
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
  handlePostCompact,
  handlePreCompact,
  parseClaudeTranscript
};

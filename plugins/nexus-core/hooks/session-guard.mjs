#!/usr/bin/env node
// GENERATED FILE -- do not edit directly. Built from adapters/claude-code/session-guard/nexus-session-guard.ts by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.

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

// core/session-guard/logic.ts
var PLUGIN_META = {
  name: "nexus-session-guard",
  version: "1.1.3",
  description: "Detects code-changing tool completions and reminds the agent to call nexus_session_append before proceeding."
};
var DEFAULT_TRIGGER_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit"]);
var DEFAULT_TRIGGER_MCP = /* @__PURE__ */ new Set([
  "nexus_task_create",
  "nexus_adr_create",
  "nexus_adr_decide"
]);
var READ_ONLY_BASH_PATTERNS = [
  /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|ls|find|grep|rg|awk|sed\s+-n|echo|printf|which|type|command\s+-v|node\s+-e|node\s+--eval)/,
  /^\s*(git\s+(status|log|diff|show|branch|remote|tag))/,
  /^\s*(rtk\s+(gain|discover))/,
  /^\s*(npm\s+(ls|list|view|info|outdated|audit))/,
  /^\s*(npx\s+--yes\s+)/,
  // npx installs are typically read-ish
  /^\s*(pwd|hostname|uname|env|printenv|id|whoami)/
];
function isBashReadOnly(input) {
  const cmd = String(input?.command ?? input?.cmd ?? "");
  if (!cmd) return true;
  return READ_ONLY_BASH_PATTERNS.some((p) => p.test(cmd));
}
var TRIGGER_THRESHOLD = 3;
var REMINDER_MESSAGE = "<system-reminder>\n[nexus-session-guard] You completed a code-changing operation but have not appended a session entry since the last user instruction. Please call nexus_session_append with a summary of what was just done before proceeding to the next task.\n</system-reminder>";
function initialState() {
  return {
    lastUserTurnIndex: 0,
    lastAppendTurnIndex: 0,
    triggerCountThisTurn: 0,
    reminderFiredThisTurn: false,
    reminderCount: 0,
    suppressCount: 0
  };
}
function onUserTurn(state) {
  state.lastUserTurnIndex++;
  state.triggerCountThisTurn = 0;
  state.reminderFiredThisTurn = false;
  return state;
}
function isTriggerTool(toolName, input) {
  if (DEFAULT_TRIGGER_TOOLS.has(toolName)) return true;
  if (DEFAULT_TRIGGER_MCP.has(toolName)) return true;
  if (toolName === "Bash" || toolName === "bash") {
    return !isBashReadOnly(input);
  }
  return false;
}
function evaluateToolCompletion(state, toolName, input) {
  if (!toolName) return { action: "not_a_trigger" };
  if (toolName === "nexus_session_append") {
    state.lastAppendTurnIndex = state.lastUserTurnIndex;
    return { action: "session_append_recorded" };
  }
  if (!isTriggerTool(toolName, input)) return { action: "not_a_trigger" };
  state.triggerCountThisTurn++;
  if (state.lastUserTurnIndex <= state.lastAppendTurnIndex) {
    state.suppressCount++;
    return { action: "suppressed_already_recorded" };
  }
  if (state.triggerCountThisTurn < TRIGGER_THRESHOLD) {
    return { action: "suppressed_below_threshold" };
  }
  if (state.reminderFiredThisTurn) {
    return { action: "suppressed_already_reminded" };
  }
  state.reminderFiredThisTurn = true;
  state.reminderCount++;
  return { action: "remind" };
}

// adapters/claude-code/session-guard/nexus-session-guard.ts
var STATE_FILE = "session-guard-state.json";
function normalizeClaudeToolName(toolName) {
  const mcpMatch = toolName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (!mcpMatch) return toolName;
  const [, server, rest] = mcpMatch;
  if (server === "nexus-headroom") return rest;
  if (server === "nexus") return `nexus_${rest}`;
  return toolName;
}
function handleHookEvent(mode, input, fileLog) {
  const directory = input.cwd ?? process.cwd();
  const state = loadState(directory, STATE_FILE, initialState());
  if (mode === "user-prompt-submit") {
    onUserTurn(state);
    saveState(directory, STATE_FILE, state);
    fileLog("debug", `User turn ${state.lastUserTurnIndex} detected (UserPromptSubmit) \u2014 counters reset`);
    return null;
  }
  if (mode === "post-tool-use") {
    const toolName = normalizeClaudeToolName(String(input.tool_name ?? ""));
    const toolInput = input.tool_input ?? {};
    const result = evaluateToolCompletion(state, toolName, toolInput);
    saveState(directory, STATE_FILE, state);
    if (result.action !== "remind") {
      fileLog("debug", `Tool ${toolName} \u2014 action=${result.action}`);
      return null;
    }
    fileLog(
      "info",
      `REMINDER #${state.reminderCount} \u2014 tool=${toolName}, user=${state.lastUserTurnIndex}, append=${state.lastAppendTurnIndex}`
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: REMINDER_MESSAGE
      }
    };
  }
  fileLog("warn", `Unknown mode "${mode}" (expected user-prompt-submit|post-tool-use) \u2014 no-op`);
  return null;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
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
  const fileLog = createFileLogger(directory, "session-guard.log");
  const output = handleHookEvent(mode, input, fileLog);
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
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
  STATE_FILE,
  handleHookEvent,
  normalizeClaudeToolName
};

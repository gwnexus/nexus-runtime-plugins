#!/usr/bin/env node
// GENERATED FILE -- do not edit directly. Built from adapters/claude-code/session-guard/nexus-session-guard.ts by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.

// core/logger.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
var DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
var CHECK_EVERY_WRITES = 200;
function createFileLogger(directory, logFileName, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  let logDir = null;
  let writes = 0;
  return (level, message) => {
    try {
      if (!logDir) {
        logDir = join(directory, ".nexus");
        mkdirSync(logDir, { recursive: true });
      }
      const path = join(logDir, logFileName);
      if (writes++ % CHECK_EVERY_WRITES === 0) rotateIfNeeded(path, maxBytes);
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}
`;
      appendFileSync(path, line);
    } catch {
    }
  };
}
function rotateIfNeeded(path, maxBytes) {
  try {
    if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`);
  } catch {
  }
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
  version: "1.2.1",
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

// core/session-guard/release-line.ts
import { readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";
import { isAbsolute, join as join5, resolve } from "node:path";

// core/headroom-intercept/config.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";

// core/nexus-config.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
function resolveNexusConfig(directory, env = process.env) {
  const fromEnv = { apiUrl: nonEmpty(env.NEXUS_API_URL), token: nonEmpty(env.NEXUS_PRIVATE_TOKEN) };
  if (fromEnv.apiUrl && fromEnv.token) return { apiUrl: fromEnv.apiUrl, token: fromEnv.token, source: "env" };
  const project = readTomlPair(join3(directory, ".nexus"));
  const pinnedUrl = project.apiUrl ? normalizeUrl(project.apiUrl) : null;
  if (project.apiUrl && project.token) return { apiUrl: project.apiUrl, token: project.token, source: "project" };
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const later = [
    ["env", () => fromEnv],
    ["mcp", () => readJsonEnv(join3(directory, ".mcp.json"), (j) => j?.mcpServers?.nexus?.env)],
    ["opencode", () => readJsonEnv(join3(directory, "opencode.json"), (j) => j?.mcp?.nexus?.environment)],
    ["global", () => home ? readTomlPair(join3(home, ".config", "nexus")) : {}]
  ];
  for (const [source, read] of later) {
    const c = read();
    if (!c.token) continue;
    if (!c.apiUrl) {
      if (project.apiUrl) return { apiUrl: project.apiUrl, token: c.token, source };
      continue;
    }
    if (pinnedUrl && normalizeUrl(c.apiUrl) !== pinnedUrl) continue;
    return { apiUrl: c.apiUrl, token: c.token, source };
  }
  return null;
}
function readTomlPair(dir) {
  return {
    apiUrl: readTomlString(join3(dir, "config.toml"), "api_url"),
    token: readTomlString(join3(dir, "credentials.toml"), "token")
  };
}
function readTomlString(path, key) {
  try {
    const m = readFileSync2(path, "utf-8").match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
    return m ? nonEmpty(m[1]) : void 0;
  } catch {
    return void 0;
  }
}
function readJsonEnv(path, pick) {
  try {
    const block = pick(JSON.parse(readFileSync2(path, "utf-8")));
    if (typeof block !== "object" || block === null) return {};
    const e = block;
    return {
      apiUrl: typeof e.NEXUS_API_URL === "string" ? nonEmpty(e.NEXUS_API_URL) : void 0,
      token: typeof e.NEXUS_PRIVATE_TOKEN === "string" ? nonEmpty(e.NEXUS_PRIVATE_TOKEN) : void 0
    };
  } catch {
    return {};
  }
}
function nonEmpty(v) {
  const t = v?.trim();
  return t && !t.startsWith("${") ? t : void 0;
}
function normalizeUrl(url) {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

// core/headroom-intercept/config.ts
function getNexusConfig(directory) {
  return resolveNexusConfig(directory);
}
function readProjectIdFromAgentsMd(directory) {
  try {
    const agentsPath = join4(directory, ".nexus", "AGENTS.md");
    if (!existsSync2(agentsPath)) return null;
    const raw = readFileSync3(agentsPath, "utf-8");
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const pidMatch = fmMatch[1].match(/project_id:\s*([0-9a-f-]{36})/);
    return pidMatch ? pidMatch[1] : null;
  } catch {
    return null;
  }
}

// core/session-guard/release-line.ts
var RELEASE_BRANCH_RE = /^staging\/release-(\d+\.\d+\.\d+)$/;
var RELEASE_NUDGE_ENV = "NEXUS_SESSION_GUARD_RELEASE_NUDGE";
var SESSION_LOOKUP_TIMEOUT_MS = 3e3;
function isReleaseNudgeEnabled(env = process.env) {
  const v = env[RELEASE_NUDGE_ENV]?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}
function readGitBranch(projectRoot) {
  try {
    const gitPath = join5(projectRoot, ".git");
    let gitDir = gitPath;
    if (statSync2(gitPath).isFile()) {
      const m = readFileSync4(gitPath, "utf-8").match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      const raw = m[1].trim();
      gitDir = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
    }
    const head = readFileSync4(join5(gitDir, "HEAD"), "utf-8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : null;
  } catch {
    return null;
  }
}
function titleMatchesBranch(title, branch) {
  if (!title.startsWith(branch)) return false;
  const next = title.charAt(branch.length);
  return next === "" || next === ":" || /\s/.test(next);
}
function evaluateReleaseLine(branch, openSessions) {
  if (!branch) return { action: "skip", reason: "no_branch" };
  if (!RELEASE_BRANCH_RE.test(branch)) return { action: "skip", reason: "not_release_branch" };
  if (!openSessions) return { action: "skip", reason: "sessions_unknown" };
  if (openSessions.some((s) => titleMatchesBranch(s.title, branch))) return { action: "in_line" };
  return { action: "nudge", message: formatReleaseNudge(branch, openSessions[0]?.title ?? null) };
}
function formatReleaseNudge(branch, openTitle) {
  const open = openTitle ? ` (open: "${truncate(openTitle, 80)}")` : " (no open session)";
  const close = openTitle ? "close it with a summary (/nexus-session-close) and " : "";
  return `[nexus-session-guard] Branch ${branch} has no matching Nexus session${open}. Per project rule: ${close}start "${branch}: <focus>" (/nexus-init).`;
}
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
async function fetchOpenSessions(config, projectId, timeoutMs = SESSION_LOOKUP_TIMEOUT_MS) {
  try {
    const res = await fetch(`${config.apiUrl}/api/mcp/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ action: "session_list", project_id: projectId }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.sessions)) return null;
    return data.sessions.filter((s) => typeof s?.title === "string" && (s.status === void 0 || s.status === "open")).map((s) => ({ title: s.title }));
  } catch {
    return null;
  }
}
async function checkReleaseLine(projectRoot, env = process.env, lookup = fetchOpenSessions, resolveConfig = getNexusConfig) {
  if (!isReleaseNudgeEnabled(env)) return null;
  const branch = readGitBranch(projectRoot);
  if (!branch || !RELEASE_BRANCH_RE.test(branch)) return evaluateReleaseLine(branch, null);
  const config = resolveConfig(projectRoot);
  const projectId = env.NEXUS_PROJECT_ID?.trim() || readProjectIdFromAgentsMd(projectRoot);
  const sessions = config && projectId ? await lookup(config, projectId) : null;
  return evaluateReleaseLine(branch, sessions);
}

// core/project-root.ts
import { statSync as statSync3 } from "node:fs";
import { dirname, resolve as resolve2 } from "node:path";
function resolveProjectRoot(cwd, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR?.trim();
  if (projectDir) return resolve2(projectDir);
  return findGitTopLevel(cwd ?? process.cwd());
}
function findGitTopLevel(start) {
  let dir = resolve2(start);
  for (let i = 0; i < 64; i++) {
    if (hasGitEntry(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
function hasGitEntry(dir) {
  try {
    const st = statSync3(resolve2(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

// core/entrypoint.ts
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
function isEntrypoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
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
  fileLog("warn", `Unknown mode "${mode}" (expected session-start|user-prompt-submit|post-tool-use) \u2014 no-op`);
  return null;
}
async function handleSessionStart(directory, fileLog, env = process.env, lookup) {
  const result = await checkReleaseLine(directory, env, lookup);
  if (!result) {
    fileLog("debug", "Release-line nudge disabled");
    return null;
  }
  if (result.action !== "nudge") {
    fileLog("debug", `Release-line check: ${result.action === "skip" ? result.reason : "in_line"}`);
    return null;
  }
  fileLog("info", `Release-line nudge: ${result.message}`);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result.message
    }
  };
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
  const directory = resolveProjectRoot(input.cwd);
  if (!directory) process.exit(0);
  input = { ...input, cwd: directory };
  const fileLog = createFileLogger(directory, "session-guard.log");
  const output = mode === "session-start" ? await handleSessionStart(directory, fileLog) : handleHookEvent(mode, input, fileLog);
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
  process.exit(0);
}
if (isEntrypoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}
`);
    process.exit(0);
  });
}
export {
  STATE_FILE,
  handleHookEvent,
  handleSessionStart,
  normalizeClaudeToolName
};

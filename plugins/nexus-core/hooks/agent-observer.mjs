#!/usr/bin/env node
// GENERATED FILE -- do not edit directly. Built from adapters/claude-code/agent-observer/nexus-agent-observer.ts by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.

// adapters/claude-code/agent-observer/nexus-agent-observer.ts
import { existsSync } from "node:fs";
import { isAbsolute as isAbsolute2, join as join3, resolve as resolve3 } from "node:path";

// core/agent-observer/types.ts
var PLUGIN_META = {
  name: "nexus-agent-observer",
  version: "1.0.1",
  description: "Writes nexus.agent-observation.v1 events from Claude Code hooks for the Agent Observability pane."
};
var OBSERVATION_SCHEMA = "nexus.agent-observation.v1";
var TASK_MAX_CHARS = 120;
function initialObserverState() {
  return { agents: {}, pending: [], taskIds: {} };
}

// core/agent-observer/mapping.ts
var AGENT_TOOLS = /* @__PURE__ */ new Set(["Agent", "Task"]);
var DEFAULT_SUBAGENT_TYPE = "general-purpose";
function summarizeTask(text) {
  if (typeof text !== "string") return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.length <= TASK_MAX_CHARS ? oneLine : oneLine.slice(0, TASK_MAX_CHARS - 1) + "\u2026";
}
function parseTaskNotification(prompt) {
  if (typeof prompt !== "string" || !prompt.trimStart().startsWith("<task-notification>")) return null;
  const tag = (name) => prompt.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() || null;
  return {
    taskId: tag("task-id"),
    toolUseId: tag("tool-use-id"),
    status: tag("status")
  };
}
function notificationState(status) {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
    case "success":
      return "done";
    case "failed":
    case "error":
    case "killed":
      return "failed";
    default:
      return "unknown";
  }
}
function observe(input, state, ctx) {
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : null;
  if (!event) return null;
  const nowIso = ctx.now.toISOString();
  const sessionId = str(input.session_id);
  const toolName = str(input.tool_name);
  const toolUseId = str(input.tool_use_id);
  const toolInput = obj(input.tool_input);
  const callerId = str(input.agent_id) ?? sessionId;
  const touch = (id, role, parentAgentId) => {
    if (!id) return null;
    let a = state.agents[id];
    if (!a) {
      a = {
        role,
        parentAgentId,
        startedAt: nowIso,
        lastSeenAt: nowIso,
        task: null,
        model: null,
        toolUseId: null,
        state: "unknown",
        usage: null
      };
      state.agents[id] = a;
    }
    a.lastSeenAt = nowIso;
    return a;
  };
  const touchCaller = () => str(input.agent_id) ? touch(callerId, "subagent", state.agents[callerId]?.parentAgentId ?? sessionId) : touch(sessionId, "main", null);
  let subjectId = callerId;
  let subject;
  let recState = "unknown";
  let recTool = null;
  let recToolUseId = null;
  switch (event) {
    case "SessionStart": {
      subjectId = sessionId;
      subject = touch(sessionId, "main", null);
      if (subject && typeof input.model === "string") subject.model = input.model;
      break;
    }
    case "UserPromptSubmit": {
      const note = parseTaskNotification(input.prompt);
      const target = note ? resolveNotificationTarget(state, note) : null;
      if (note && target) {
        subjectId = target;
        subject = touch(target, state.agents[target]?.role ?? "background", sessionId);
        recState = notificationState(note.status);
      } else {
        subject = touchCaller();
        recState = "working";
        if (subject && !note) subject.task = summarizeTask(input.prompt) ?? subject.task;
      }
      break;
    }
    case "PreToolUse": {
      subject = touchCaller();
      recState = "working";
      recTool = toolName;
      recToolUseId = toolUseId;
      if (toolName === "Bash" && toolInput.run_in_background === true && toolUseId) {
        const bg = touch(toolUseId, "background", callerId);
        bg.task = summarizeTask(toolInput.description) ?? "Background shell";
        bg.toolUseId = toolUseId;
        subjectId = toolUseId;
        subject = bg;
      } else if (toolName && AGENT_TOOLS.has(toolName) && toolUseId && callerId) {
        state.pending.push({
          toolUseId,
          parentAgentId: callerId,
          subagentType: str(toolInput.subagent_type) ?? DEFAULT_SUBAGENT_TYPE,
          task: summarizeTask(toolInput.description),
          at: nowIso
        });
      }
      break;
    }
    case "PostToolUse": {
      subject = touchCaller();
      recState = "working";
      recTool = toolName;
      recToolUseId = toolUseId;
      const resp = obj(input.tool_response);
      if (toolName && AGENT_TOOLS.has(toolName)) {
        const agentId = str(resp.agentId);
        if (agentId) linkSubagent(state, agentId, toolUseId, callerId, str(resp.resolvedModel), str(resp.status), touch);
      } else if (toolName === "Bash" && toolUseId) {
        const bgTaskId = str(resp.backgroundTaskId);
        if (bgTaskId && state.agents[toolUseId]) state.taskIds[bgTaskId] = toolUseId;
      }
      break;
    }
    case "PostToolUseFailure": {
      subject = touchCaller();
      recState = "working";
      recTool = toolName;
      recToolUseId = toolUseId;
      if (toolName === "Bash" && toolInput.run_in_background === true && toolUseId && state.agents[toolUseId]) {
        subjectId = toolUseId;
        subject = touch(toolUseId, "background", callerId);
        recState = "failed";
      } else if (toolName && AGENT_TOOLS.has(toolName) && toolUseId) {
        state.pending = state.pending.filter((p) => p.toolUseId !== toolUseId);
      }
      break;
    }
    case "Notification": {
      subject = touchCaller();
      recState = "waiting";
      break;
    }
    case "SubagentStart": {
      const agentId = str(input.agent_id);
      subjectId = agentId;
      const known = agentId ? state.agents[agentId] : void 0;
      let parent = known?.parentAgentId ?? null;
      let task = known?.task ?? null;
      let spawnToolUseId = known?.toolUseId ?? null;
      if (!spawnToolUseId) {
        const agentType = str(input.agent_type);
        const idx = state.pending.findIndex((p) => p.subagentType === agentType);
        if (idx >= 0) {
          const [p] = state.pending.splice(idx, 1);
          parent = p.parentAgentId;
          task = p.task;
          spawnToolUseId = p.toolUseId;
        }
      }
      subject = touch(agentId, "subagent", parent ?? sessionId);
      if (subject) {
        subject.parentAgentId = parent ?? subject.parentAgentId ?? sessionId;
        subject.task = task ?? subject.task ?? summarizeTask(input.agent_type);
        subject.toolUseId = spawnToolUseId;
        if (agentId) state.taskIds[agentId] = agentId;
      }
      recState = "working";
      recToolUseId = spawnToolUseId;
      break;
    }
    case "SubagentStop": {
      subject = touchCaller();
      recState = "done";
      const path = str(input.agent_transcript_path);
      if (subject && path) applyUsage(subject, ctx.readUsage(path, subject.usage, {}));
      break;
    }
    case "Stop":
    case "StopFailure":
    case "SessionEnd": {
      subjectId = sessionId;
      subject = touch(sessionId, "main", null);
      recState = event === "StopFailure" ? "failed" : "done";
      const path = str(input.transcript_path);
      if (subject && path && event !== "SessionEnd")
        applyUsage(subject, ctx.readUsage(path, subject.usage, { skipSidechain: true }));
      break;
    }
    default: {
      subject = touchCaller();
      recTool = toolName;
      recToolUseId = toolUseId;
    }
  }
  if (subject) subject.state = recState;
  return buildRecord(event, nowIso, ctx, input, sessionId, subjectId, subject ?? null, recState, recTool, recToolUseId);
}
function linkSubagent(state, agentId, toolUseId, callerId, resolvedModel, status, touch) {
  const idx = toolUseId ? state.pending.findIndex((p) => p.toolUseId === toolUseId) : -1;
  const pending = idx >= 0 ? state.pending.splice(idx, 1)[0] : null;
  const a = touch(agentId, "subagent", pending?.parentAgentId ?? callerId);
  a.role = "subagent";
  if (pending) {
    a.parentAgentId = pending.parentAgentId;
    a.task = pending.task ?? a.task;
  }
  if (toolUseId) a.toolUseId = toolUseId;
  if (resolvedModel) a.model = resolvedModel;
  if (status === "async_launched" && a.state === "unknown") a.state = "working";
  state.taskIds[agentId] = agentId;
}
function resolveNotificationTarget(state, note) {
  if (note.taskId) {
    const mapped = state.taskIds[note.taskId];
    if (mapped && state.agents[mapped]) return mapped;
    if (state.agents[note.taskId]) return note.taskId;
  }
  if (note.toolUseId) {
    if (state.agents[note.toolUseId]) return note.toolUseId;
    for (const [id, a] of Object.entries(state.agents)) if (a.toolUseId === note.toolUseId) return id;
  }
  return null;
}
function applyUsage(agent, update) {
  agent.usage = update.cursor;
  if (update.model) agent.model = update.model;
}
function buildRecord(event, nowIso, ctx, input, sessionId, agentId, agent, recState, tool, toolUseId) {
  const startedAt = agent?.startedAt ?? null;
  const runtimeMs = startedAt ? Math.max(0, ctx.now.getTime() - Date.parse(startedAt)) : null;
  return {
    schema: OBSERVATION_SCHEMA,
    ts: nowIso,
    event,
    sessionId,
    agentId,
    parentAgentId: agent?.parentAgentId ?? null,
    role: agent?.role ?? (str(input.agent_id) ? "subagent" : "main"),
    state: recState,
    task: agent?.task ?? null,
    tool,
    toolUseId,
    model: agent?.model ?? null,
    repository: ctx.repo.repository,
    cwd: str(input.cwd),
    worktree: ctx.repo.worktree,
    startedAt,
    runtimeMs,
    inputTokens: agent?.usage ? agent.usage.inputTokens : null,
    outputTokens: agent?.usage ? agent.usage.outputTokens : null
  };
}
function str(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function obj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
}

// core/agent-observer/git.ts
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
function resolveRepoInfo(cwd) {
  if (!cwd) return { repository: null, worktree: null };
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const gitPath = resolve(dir, ".git");
    const kind = entryKind(gitPath);
    if (kind === "dir") return { repository: basename(dir), worktree: null };
    if (kind === "file") return fromGitFile(dir, gitPath);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { repository: null, worktree: null };
}
function entryKind(path) {
  try {
    const st = statSync(path);
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return null;
  } catch {
    return null;
  }
}
function fromGitFile(topLevel, gitFile) {
  try {
    const match = readFileSync(gitFile, "utf-8").match(/^gitdir:\s*(.+)$/m);
    if (match) {
      const raw = match[1].trim();
      const gitDir = isAbsolute(raw) ? raw : resolve(topLevel, raw);
      const wt = gitDir.replace(/\\/g, "/").match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
      if (wt) return { repository: basename(wt[1]), worktree: topLevel };
    }
  } catch {
  }
  return { repository: basename(topLevel), worktree: null };
}

// core/project-root.ts
import { statSync as statSync2 } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
function resolveProjectRoot(cwd, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR?.trim();
  if (projectDir) return resolve2(projectDir);
  return findGitTopLevel(cwd ?? process.cwd());
}
function findGitTopLevel(start) {
  let dir = resolve2(start);
  for (let i = 0; i < 64; i++) {
    if (hasGitEntry(dir)) return dir;
    const parent = dirname2(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
function hasGitEntry(dir) {
  try {
    const st = statSync2(resolve2(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

// core/agent-observer/transcript.ts
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
var MAX_READ_BYTES = 16 * 1024 * 1024;
function emptyCursor(path) {
  return {
    path,
    offset: 0,
    lastMessageId: null,
    lastInput: 0,
    lastOutput: 0,
    inputTokens: 0,
    outputTokens: 0
  };
}
function readUsageIncrement(path, previous, opts = {}) {
  const cursor = previous && previous.path === path ? { ...previous } : emptyCursor(path);
  let model = null;
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size < cursor.offset) Object.assign(cursor, emptyCursor(path));
    const length = Math.min(size - cursor.offset, MAX_READ_BYTES);
    if (length <= 0) return { cursor, model };
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, cursor.offset);
    const lastNewline = buf.lastIndexOf(10, read - 1);
    if (lastNewline < 0) return { cursor, model };
    const text = buf.subarray(0, lastNewline).toString("utf-8");
    cursor.offset += lastNewline + 1;
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "assistant") continue;
      if (opts.skipSidechain && entry.isSidechain === true) continue;
      const msg = entry.message;
      if (!msg || typeof msg !== "object") continue;
      if (typeof msg.model === "string" && msg.model !== "<synthetic>") model = msg.model;
      const usage = msg.usage;
      if (!usage || typeof usage !== "object") continue;
      const input = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
      const output = num(usage.output_tokens);
      const id = typeof msg.id === "string" ? msg.id : null;
      if (id !== null && id === cursor.lastMessageId) {
        cursor.inputTokens -= cursor.lastInput;
        cursor.outputTokens -= cursor.lastOutput;
      }
      cursor.inputTokens += input;
      cursor.outputTokens += output;
      cursor.lastMessageId = id;
      cursor.lastInput = input;
      cursor.lastOutput = output;
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
  return { cursor, model };
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// core/agent-observer/state.ts
import { closeSync as closeSync2, mkdirSync, openSync as openSync2, readFileSync as readFileSync2, renameSync, statSync as statSync3, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var STATE_FILE = "state.json";
var STATE_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_PENDING = 50;
var LOCK_FILE = "state.lock";
var LOCK_WAIT_MS = 50;
var LOCK_STALE_MS = 2e3;
var sleepCell = new Int32Array(new SharedArrayBuffer(4));
function withObserverLock(observerDir, fn) {
  const lockPath = join(observerDir, LOCK_FILE);
  let fd = null;
  try {
    mkdirSync(observerDir, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (fd === null) {
      try {
        fd = openSync2(lockPath, "wx");
      } catch (err) {
        if (err?.code !== "EEXIST") break;
        if (isStale(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
          }
          continue;
        }
        if (Date.now() >= deadline) break;
        Atomics.wait(sleepCell, 0, 0, 2);
      }
    }
  } catch {
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync2(fd);
        unlinkSync(lockPath);
      } catch {
      }
    }
  }
}
function isStale(lockPath) {
  try {
    return Date.now() - statSync3(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}
function loadObserverState(observerDir) {
  try {
    const parsed = JSON.parse(readFileSync2(join(observerDir, STATE_FILE), "utf-8"));
    const base = initialObserverState();
    return {
      agents: isObj(parsed?.agents) ? parsed.agents : base.agents,
      pending: Array.isArray(parsed?.pending) ? parsed.pending : base.pending,
      taskIds: isObj(parsed?.taskIds) ? parsed.taskIds : base.taskIds
    };
  } catch {
    return initialObserverState();
  }
}
function saveObserverState(observerDir, state, now = Date.now()) {
  try {
    mkdirSync(observerDir, { recursive: true });
    const pruned = pruneState(state, now);
    const tmp = join(observerDir, `${STATE_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(pruned));
    renameSync(tmp, join(observerDir, STATE_FILE));
  } catch {
  }
}
function pruneState(state, now) {
  const cutoff = now - STATE_TTL_MS;
  const agents = {};
  for (const [id, a] of Object.entries(state.agents)) {
    if (Date.parse(a.lastSeenAt) >= cutoff) agents[id] = a;
  }
  const taskIds = {};
  for (const [taskId, agentId] of Object.entries(state.taskIds)) {
    if (agents[agentId]) taskIds[taskId] = agentId;
  }
  const pending = state.pending.filter((p) => Date.parse(p.at) >= cutoff).slice(-MAX_PENDING);
  return { agents, pending, taskIds };
}
function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// core/agent-observer/writer.ts
import { appendFileSync, mkdirSync as mkdirSync2, renameSync as renameSync2, statSync as statSync4 } from "node:fs";
import { join as join2 } from "node:path";
var EVENTS_FILE = "events.jsonl";
var ROTATED_FILE = "events.1.jsonl";
var DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
function appendRecords(observerDir, records, maxBytes = DEFAULT_MAX_BYTES) {
  if (records.length === 0) return true;
  try {
    mkdirSync2(observerDir, { recursive: true });
    const path = join2(observerDir, EVENTS_FILE);
    rotateIfNeeded(observerDir, path, maxBytes);
    const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(path, payload);
    return true;
  } catch {
    return false;
  }
}
function rotateIfNeeded(observerDir, path, maxBytes) {
  let size;
  try {
    size = statSync4(path).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  renameSync2(path, join2(observerDir, ROTATED_FILE));
}

// adapters/claude-code/agent-observer/nexus-agent-observer.ts
function resolveObserverDir(env, input) {
  const projectDir = resolveProjectRoot(typeof input.cwd === "string" ? input.cwd : null, env);
  if (!projectDir) return null;
  const override = env.NEXUS_AGENTIC_ROOT;
  const root = override ? isAbsolute2(override) ? override : resolve3(projectDir, override) : join3(projectDir, ".nexus");
  return join3(root, "claude", "observer");
}
function handleHookPayload(input, env = process.env, now = /* @__PURE__ */ new Date()) {
  const observerDir = resolveObserverDir(env, input);
  if (!observerDir) return false;
  const agenticRoot = resolve3(observerDir, "..", "..");
  if (!existsSync(agenticRoot)) return false;
  const repo = resolveRepoInfo(typeof input.cwd === "string" ? input.cwd : null);
  return withObserverLock(observerDir, () => {
    const state = loadObserverState(observerDir);
    const ctx = { now, repo, readUsage: readUsageIncrement };
    const record = observe(input, state, ctx);
    if (!record) return false;
    saveObserverState(observerDir, state, now.getTime());
    return appendRecords(observerDir, [record]);
  });
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin() || "{}");
  } catch {
    process.exit(0);
  }
  handleHookPayload(input);
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
  handleHookPayload,
  resolveObserverDir
};

/**
 * nexus-agent-observer event mapping.
 *
 * Pure(ish) translation of one Claude Code hook payload into one
 * `nexus.agent-observation.v1` record, updating the persisted observer state
 * in place. All filesystem access is injected via `ObserveContext`, so this
 * module is unit-testable against the recorded payload fixtures.
 *
 * Linking rules (verified against live Claude Code 2.1.283 payloads):
 * - Hooks fired inside a subagent carry `agent_id`/`agent_type`; without
 *   them the caller is the main agent (agentId = session id).
 * - `PreToolUse` for `Agent` (older builds: `Task`) queues a pending spawn
 *   with the tool_use_id, caller and `description`.
 * - Foreground spawn: `SubagentStart` fires before `PostToolUse(Agent)`; the
 *   pending spawn is matched by `agent_type == subagent_type` (oldest first).
 *   Background spawn: `PostToolUse(Agent)` (`status: "async_launched"`) fires
 *   first. Either way `tool_response.agentId` on `PostToolUse(Agent)` is the
 *   authoritative tool_use_id <-> agent_id link.
 * - Background shells: `PreToolUse(Bash)` with `tool_input.run_in_background`
 *   starts a `background` agent keyed by tool_use_id; `PostToolUse` returns
 *   `tool_response.backgroundTaskId`. Completion of background shells and
 *   background subagents arrives as a `UserPromptSubmit` whose prompt is a
 *   `<task-notification>` (`<task-id>`, `<tool-use-id>`, `<status>`).
 *
 * Privacy: only tool names, ids, `description` / `subagent_type` /
 * `run_in_background` from `tool_input`, `agentId` / `resolvedModel` /
 * `status` / `backgroundTaskId` from `tool_response`, and a 120-char
 * single-line prompt summary are ever read into records or state.
 */
import {
  OBSERVATION_SCHEMA,
  TASK_MAX_CHARS,
  type AgentObservation,
  type AgentRole,
  type AgentState,
  type ObserverHookInput,
  type ObserverState,
  type RepoInfo,
  type TrackedAgent,
  type UsageCursor,
} from "./types.ts"
import type { UsageUpdate } from "./transcript.ts"

export interface ObserveContext {
  now: Date
  repo: RepoInfo
  readUsage: (path: string, previous: UsageCursor | null, opts: { skipSidechain?: boolean }) => UsageUpdate
}

const AGENT_TOOLS = new Set(["Agent", "Task"])
/** Claude Code's subagent type when the Agent call omits `subagent_type` (observed live). */
const DEFAULT_SUBAGENT_TYPE = "general-purpose"

export function summarizeTask(text: unknown): string | null {
  if (typeof text !== "string") return null
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (!oneLine) return null
  return oneLine.length <= TASK_MAX_CHARS ? oneLine : oneLine.slice(0, TASK_MAX_CHARS - 1) + "…"
}

export interface TaskNotification {
  taskId: string | null
  toolUseId: string | null
  status: string | null
}

export function parseTaskNotification(prompt: unknown): TaskNotification | null {
  if (typeof prompt !== "string" || !prompt.trimStart().startsWith("<task-notification>")) return null
  const tag = (name: string) => prompt.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() || null
  return {
    taskId: tag("task-id"),
    toolUseId: tag("tool-use-id"),
    status: tag("status"),
  }
}

export function notificationState(status: string | null): AgentState {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
    case "success":
      return "done"
    case "failed":
    case "error":
    case "killed":
      return "failed"
    default:
      return "unknown"
  }
}

export function observe(input: ObserverHookInput, state: ObserverState, ctx: ObserveContext): AgentObservation | null {
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : null
  if (!event) return null
  const nowIso = ctx.now.toISOString()
  const sessionId = str(input.session_id)
  const toolName = str(input.tool_name)
  const toolUseId = str(input.tool_use_id)
  const toolInput = obj(input.tool_input)
  const callerId = str(input.agent_id) ?? sessionId

  const touch = (id: string | null, role: AgentRole, parentAgentId: string | null): TrackedAgent | null => {
    if (!id) return null
    let a = state.agents[id]
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
        usage: null,
      }
      state.agents[id] = a
    }
    a.lastSeenAt = nowIso
    return a
  }
  const touchCaller = (): TrackedAgent | null =>
    str(input.agent_id)
      ? touch(callerId, "subagent", state.agents[callerId!]?.parentAgentId ?? sessionId)
      : touch(sessionId, "main", null)

  let subjectId: string | null = callerId
  let subject: TrackedAgent | null
  let recState: AgentState = "unknown"
  let recTool: string | null = null
  let recToolUseId: string | null = null

  switch (event) {
    case "SessionStart": {
      subjectId = sessionId
      subject = touch(sessionId, "main", null)
      if (subject && typeof input.model === "string") subject.model = input.model
      break
    }

    case "UserPromptSubmit": {
      const note = parseTaskNotification(input.prompt)
      const target = note ? resolveNotificationTarget(state, note) : null
      if (note && target) {
        subjectId = target
        subject = touch(target, state.agents[target]?.role ?? "background", sessionId)
        recState = notificationState(note.status)
      } else {
        subject = touchCaller()
        recState = "working"
        if (subject && !note) subject.task = summarizeTask(input.prompt) ?? subject.task
      }
      break
    }

    case "PreToolUse": {
      subject = touchCaller()
      recState = "working"
      recTool = toolName
      recToolUseId = toolUseId
      if (toolName === "Bash" && toolInput.run_in_background === true && toolUseId) {
        const bg = touch(toolUseId, "background", callerId)!
        bg.task = summarizeTask(toolInput.description) ?? "Background shell"
        bg.toolUseId = toolUseId
        subjectId = toolUseId
        subject = bg
      } else if (toolName && AGENT_TOOLS.has(toolName) && toolUseId && callerId) {
        state.pending.push({
          toolUseId,
          parentAgentId: callerId,
          subagentType: str(toolInput.subagent_type) ?? DEFAULT_SUBAGENT_TYPE,
          task: summarizeTask(toolInput.description),
          at: nowIso,
        })
      }
      break
    }

    case "PostToolUse": {
      subject = touchCaller()
      recState = "working"
      recTool = toolName
      recToolUseId = toolUseId
      const resp = obj(input.tool_response)
      if (toolName && AGENT_TOOLS.has(toolName)) {
        const agentId = str(resp.agentId)
        if (agentId) linkSubagent(state, agentId, toolUseId, callerId, str(resp.resolvedModel), str(resp.status), touch)
      } else if (toolName === "Bash" && toolUseId) {
        const bgTaskId = str(resp.backgroundTaskId)
        if (bgTaskId && state.agents[toolUseId]) state.taskIds[bgTaskId] = toolUseId
      }
      break
    }

    case "PostToolUseFailure": {
      subject = touchCaller()
      recState = "working"
      recTool = toolName
      recToolUseId = toolUseId
      if (toolName === "Bash" && toolInput.run_in_background === true && toolUseId && state.agents[toolUseId]) {
        subjectId = toolUseId
        subject = touch(toolUseId, "background", callerId)
        recState = "failed"
      } else if (toolName && AGENT_TOOLS.has(toolName) && toolUseId) {
        state.pending = state.pending.filter((p) => p.toolUseId !== toolUseId)
      }
      break
    }

    case "Notification": {
      subject = touchCaller()
      recState = "waiting"
      break
    }

    case "SubagentStart": {
      const agentId = str(input.agent_id)
      subjectId = agentId
      const known = agentId ? state.agents[agentId] : undefined
      let parent = known?.parentAgentId ?? null
      let task = known?.task ?? null
      let spawnToolUseId = known?.toolUseId ?? null
      if (!spawnToolUseId) {
        const agentType = str(input.agent_type)
        const idx = state.pending.findIndex((p) => p.subagentType === agentType)
        if (idx >= 0) {
          const [p] = state.pending.splice(idx, 1)
          parent = p.parentAgentId
          task = p.task
          spawnToolUseId = p.toolUseId
        }
      }
      subject = touch(agentId, "subagent", parent ?? sessionId)
      if (subject) {
        subject.parentAgentId = parent ?? subject.parentAgentId ?? sessionId
        subject.task = task ?? subject.task ?? summarizeTask(input.agent_type)
        subject.toolUseId = spawnToolUseId
        if (agentId) state.taskIds[agentId] = agentId
      }
      recState = "working"
      recToolUseId = spawnToolUseId
      break
    }

    case "SubagentStop": {
      subject = touchCaller()
      recState = "done"
      const path = str(input.agent_transcript_path)
      if (subject && path) applyUsage(subject, ctx.readUsage(path, subject.usage, {}))
      break
    }

    case "Stop":
    case "StopFailure":
    case "SessionEnd": {
      subjectId = sessionId
      subject = touch(sessionId, "main", null)
      recState = event === "StopFailure" ? "failed" : "done"
      const path = str(input.transcript_path)
      if (subject && path && event !== "SessionEnd")
        applyUsage(subject, ctx.readUsage(path, subject.usage, { skipSidechain: true }))
      break
    }

    default: {
      subject = touchCaller()
      recTool = toolName
      recToolUseId = toolUseId
    }
  }

  if (subject) subject.state = recState
  return buildRecord(event, nowIso, ctx, input, sessionId, subjectId, subject ?? null, recState, recTool, recToolUseId)
}

function linkSubagent(
  state: ObserverState,
  agentId: string,
  toolUseId: string | null,
  callerId: string | null,
  resolvedModel: string | null,
  status: string | null,
  touch: (id: string | null, role: AgentRole, parent: string | null) => TrackedAgent | null,
): void {
  const idx = toolUseId ? state.pending.findIndex((p) => p.toolUseId === toolUseId) : -1
  const pending = idx >= 0 ? state.pending.splice(idx, 1)[0] : null
  const a = touch(agentId, "subagent", pending?.parentAgentId ?? callerId)!
  a.role = "subagent"
  // tool_response.agentId is authoritative: it overrides a SubagentStart
  // type-match that picked the wrong pending spawn (parallel same-type calls).
  if (pending) {
    a.parentAgentId = pending.parentAgentId
    a.task = pending.task ?? a.task
  }
  if (toolUseId) a.toolUseId = toolUseId
  if (resolvedModel) a.model = resolvedModel
  if (status === "async_launched" && a.state === "unknown") a.state = "working"
  state.taskIds[agentId] = agentId
}

function resolveNotificationTarget(state: ObserverState, note: TaskNotification): string | null {
  if (note.taskId) {
    const mapped = state.taskIds[note.taskId]
    if (mapped && state.agents[mapped]) return mapped
    if (state.agents[note.taskId]) return note.taskId
  }
  if (note.toolUseId) {
    if (state.agents[note.toolUseId]) return note.toolUseId
    for (const [id, a] of Object.entries(state.agents)) if (a.toolUseId === note.toolUseId) return id
  }
  return null
}

function applyUsage(agent: TrackedAgent, update: UsageUpdate): void {
  agent.usage = update.cursor
  if (update.model) agent.model = update.model
}

function buildRecord(
  event: string,
  nowIso: string,
  ctx: ObserveContext,
  input: ObserverHookInput,
  sessionId: string | null,
  agentId: string | null,
  agent: TrackedAgent | null,
  recState: AgentState,
  tool: string | null,
  toolUseId: string | null,
): AgentObservation {
  const startedAt = agent?.startedAt ?? null
  const runtimeMs = startedAt ? Math.max(0, ctx.now.getTime() - Date.parse(startedAt)) : null
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
    outputTokens: agent?.usage ? agent.usage.outputTokens : null,
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

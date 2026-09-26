/**
 * nexus-agent-observer types (ADR-0120).
 *
 * `AgentObservation` is one line of `<agentic_root>/claude/observer/events.jsonl`
 * and must stay in sync with
 * `plugins/nexus-core/schemas/nexus.agent-observation.v1.schema.json`.
 */

export const PLUGIN_META = {
  name: "nexus-agent-observer",
  version: "1.0.0",
  description: "Writes nexus.agent-observation.v1 events from Claude Code hooks for the Agent Observability pane.",
} as const

export const OBSERVATION_SCHEMA = "nexus.agent-observation.v1"

/** Max length of the `task` summary (dispatch 34a59203 constraint). */
export const TASK_MAX_CHARS = 120

export type AgentRole = "main" | "subagent" | "background"
export type AgentState = "working" | "waiting" | "done" | "failed" | "unknown"

export interface AgentObservation {
  schema: typeof OBSERVATION_SCHEMA
  ts: string
  event: string
  sessionId: string | null
  agentId: string | null
  parentAgentId: string | null
  role: AgentRole
  state: AgentState
  task: string | null
  tool: string | null
  toolUseId: string | null
  model: string | null
  repository: string | null
  cwd: string | null
  worktree: string | null
  startedAt: string | null
  runtimeMs: number | null
  inputTokens: number | null
  outputTokens: number | null
}

/**
 * Subset of the Claude Code hook stdin payload the observer reads. Field
 * names verified against live payloads from Claude Code 2.1.283 (see the
 * fixtures next to the adapter). `tool_input` / `tool_response` are only
 * inspected for the handful of metadata keys listed in mapping.ts; their
 * content is never written out.
 */
export interface ObserverHookInput {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  agent_id?: string
  agent_type?: string
  source?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  tool_use_id?: string
  error?: unknown
  is_interrupt?: boolean
  agent_transcript_path?: string
  model?: unknown
  [key: string]: unknown
}

/** Cursor for incremental transcript usage aggregation. */
export interface UsageCursor {
  path: string
  offset: number
  /** Last assistant message id counted, and what it contributed (streamed messages repeat their id). */
  lastMessageId: string | null
  lastInput: number
  lastOutput: number
  inputTokens: number
  outputTokens: number
}

export interface TrackedAgent {
  role: AgentRole
  parentAgentId: string | null
  startedAt: string
  lastSeenAt: string
  task: string | null
  model: string | null
  toolUseId: string | null
  state: AgentState
  usage: UsageCursor | null
}

/** A spawned-but-not-yet-linked Agent/Task tool call. */
export interface PendingAgentCall {
  toolUseId: string
  parentAgentId: string
  subagentType: string | null
  task: string | null
  at: string
}

export interface ObserverState {
  /** Keyed by agentId (main agent = session id, background shell = tool_use_id). */
  agents: Record<string, TrackedAgent>
  pending: PendingAgentCall[]
  /** Claude Code background task id (task-notification `<task-id>`) -> agentId. */
  taskIds: Record<string, string>
}

export function initialObserverState(): ObserverState {
  return { agents: {}, pending: [], taskIds: {} }
}

export interface RepoInfo {
  repository: string | null
  worktree: string | null
}

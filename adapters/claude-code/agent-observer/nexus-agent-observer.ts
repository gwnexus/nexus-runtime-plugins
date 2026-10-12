#!/usr/bin/env node
/**
 * Nexus Agent Observer — Claude Code adapter (ADR-0120, Dispatch 34a59203).
 *
 * Appends one `nexus.agent-observation.v1` JSON line per Claude Code hook
 * event to `<agentic_root>/claude/observer/events.jsonl` (normally
 * `.nexus/claude/observer/events.jsonl` under `CLAUDE_PROJECT_DIR`), which
 * `nexus status --agents` (nexus-cli) renders in the Agent Observability
 * pane. The event -> record mapping lives in core/agent-observer/mapping.ts.
 *
 * Constraints (from the dispatch): always exit 0, never write to stdout, no
 * network, no subprocesses, errors at most to stderr. Tool inputs/outputs,
 * prompt text beyond a 120-char task summary, env values and secrets are
 * never written. The observer only writes when the agentic root directory
 * already exists, so it never creates a `.nexus/` that is not covered by the
 * project's `.nexus/` git exclude.
 *
 * Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, Notification, SubagentStart, SubagentStop, Stop,
 * StopFailure, SessionEnd (tool events with matcher `*`). The event name is
 * taken from the payload's `hook_event_name`, so the command needs no mode
 * argument.
 *
 * Hook configuration (.claude/settings.json), one entry per event:
 *
 *   { "hooks": { "PreToolUse": [
 *       { "matcher": "*", "hooks": [{ "type": "command", "command": "node adapters/claude-code/agent-observer/nexus-agent-observer.ts" }] }
 *   ] } }
 */
import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { observe, type ObserveContext } from "../../../core/agent-observer/mapping.ts"
import { resolveRepoInfo } from "../../../core/agent-observer/git.ts"
import { resolveProjectRoot } from "../../../core/project-root.ts"
import { readUsageIncrement } from "../../../core/agent-observer/transcript.ts"
import { loadObserverState, saveObserverState, withObserverLock } from "../../../core/agent-observer/state.ts"
import { appendRecords } from "../../../core/agent-observer/writer.ts"
import { PLUGIN_META, type ObserverHookInput } from "../../../core/agent-observer/types.ts"
import { isEntrypoint } from "../../../core/entrypoint.ts"

/**
 * `<agentic_root>/claude/observer`. The agentic root defaults to
 * `<project>/.nexus`; `NEXUS_AGENTIC_ROOT` (absolute, or relative to the
 * project dir) overrides it.
 */
export function resolveObserverDir(env: NodeJS.ProcessEnv, input: ObserverHookInput): string | null {
  // Project root, never the session's current cwd (Dispatch b7d15add).
  const projectDir = resolveProjectRoot(typeof input.cwd === "string" ? input.cwd : null, env)
  if (!projectDir) return null
  const override = env.NEXUS_AGENTIC_ROOT
  const root = override ? (isAbsolute(override) ? override : resolve(projectDir, override)) : join(projectDir, ".nexus")
  return join(root, "claude", "observer")
}

/** Handle one hook payload end to end. Returns true when a record was written. */
export function handleHookPayload(
  input: ObserverHookInput,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): boolean {
  const observerDir = resolveObserverDir(env, input)
  if (!observerDir) return false
  const agenticRoot = resolve(observerDir, "..", "..")
  if (!existsSync(agenticRoot)) return false

  const repo = resolveRepoInfo(typeof input.cwd === "string" ? input.cwd : null)
  return withObserverLock(observerDir, (locked) => {
    const state = loadObserverState(observerDir)
    const ctx: ObserveContext = { now, repo, readUsage: readUsageIncrement }
    const record = observe(input, state, ctx)
    if (!record) return false
    // Without the lock the loaded state may be stale; saving it would drop another process's update.
    if (locked) saveObserverState(observerDir, state, now.getTime())
    return appendRecords(observerDir, [record])
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf-8")
}

async function main(): Promise<void> {
  let input: ObserverHookInput
  try {
    input = JSON.parse((await readStdin()) || "{}")
  } catch {
    process.exit(0)
  }
  handleHookPayload(input)
  process.exit(0)
}

// Only run the CLI entrypoint when executed directly, not when imported by tests.
if (isEntrypoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}\n`)
    process.exit(0)
  })
}

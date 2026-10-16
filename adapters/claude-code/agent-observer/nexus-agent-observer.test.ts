import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { observe, type ObserveContext } from "../../../core/agent-observer/mapping.ts"
import { emptyCursor } from "../../../core/agent-observer/transcript.ts"
import {
  initialObserverState,
  type AgentObservation,
  type ObserverHookInput,
  type ObserverState,
} from "../../../core/agent-observer/types.ts"
import { handleHookPayload, resolveObserverDir } from "./nexus-agent-observer.ts"

/**
 * Fixtures are live Claude Code 2.1.283 hook payloads (captured with a
 * structure-only hook in a scratch repo, then redacted: commands, prompts,
 * tool output and local paths replaced). Field names and event order are
 * exactly as Claude Code sent them.
 */
const FIXTURES = join(import.meta.dirname, "fixtures")
const SCHEMA = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../plugins/nexus-core/schemas/nexus.agent-observation.v1.schema.json"),
    "utf-8",
  ),
)

function loadFixture(name: string): ObserverHookInput[] {
  return readFileSync(join(FIXTURES, name), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const MAIN = "a5392d42-c5dc-44a2-b956-fce20388bab2"
const ASYNC_SUB = "a7cd0a155137535e7"
const BG_TOOL_USE = "toolu_01DabLvoEoPB6KHFQMhgbStu"
const FG_SUB = "a687d0fc3d6067591"

function ctxAt(ms: number, usage = { input: 1000, output: 50, model: "claude-haiku-4-5-20251001" }): ObserveContext {
  return {
    now: new Date(Date.UTC(2026, 8, 26, 17, 0, 0) + ms),
    repo: { repository: "repo", worktree: null },
    readUsage: (path, prev) => ({
      cursor: {
        ...(prev ?? emptyCursor(path)),
        inputTokens: usage.input,
        outputTokens: usage.output,
      },
      model: usage.model,
    }),
  }
}

function replay(events: ObserverHookInput[], state: ObserverState = initialObserverState(), stepMs = 1000) {
  const records = events
    .map((e, i) => observe(e, state, ctxAt(i * stepMs)))
    .filter((r): r is AgentObservation => r !== null)
  return { records, state }
}

/** Minimal validator for the published schema (no ajv dependency). */
function validate(record: AgentObservation): string[] {
  const errors: string[] = []
  const keys = Object.keys(record)
  for (const k of SCHEMA.required) if (!keys.includes(k)) errors.push(`missing ${k}`)
  for (const k of keys) if (!(k in SCHEMA.properties)) errors.push(`unexpected ${k}`)
  for (const [k, spec] of Object.entries<any>(SCHEMA.properties)) {
    const v = (record as any)[k]
    if (spec.const !== undefined && v !== spec.const) errors.push(`${k} != const`)
    if (spec.enum && !spec.enum.includes(v)) errors.push(`${k}=${v} not in enum`)
    if (spec.type) {
      const types: string[] = Array.isArray(spec.type) ? spec.type : [spec.type]
      const actual = v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v
      if (!types.includes(actual) && !(actual === "integer" && types.includes("number")))
        errors.push(`${k} type ${actual}`)
    }
    if (spec.maxLength && typeof v === "string" && v.length > spec.maxLength) errors.push(`${k} too long`)
  }
  return errors
}

describe("agent-observer: live payload fixtures", () => {
  describe("background Bash + background (async) subagent + failing tool", () => {
    const { records, state } = replay(loadFixture("background-and-async-subagent.jsonl"))
    const byEvent = (event: string) => records.filter((r) => r.event === event)

    it("writes one schema-valid record per hook event", () => {
      expect(records).toHaveLength(19)
      for (const r of records) expect(validate(r)).toEqual([])
    })

    it("tracks the main agent from SessionStart to Stop", () => {
      const start = byEvent("SessionStart")[0]
      expect(start).toMatchObject({
        agentId: MAIN,
        role: "main",
        parentAgentId: null,
        state: "unknown",
      })
      const prompt = byEvent("UserPromptSubmit")[0]
      expect(prompt).toMatchObject({
        agentId: MAIN,
        state: "working",
        task: "<redacted user prompt>",
      })
      const stop = byEvent("Stop").at(-1)!
      expect(stop).toMatchObject({
        agentId: MAIN,
        role: "main",
        state: "done",
        inputTokens: 1000,
        outputTokens: 50,
      })
      expect(stop.runtimeMs).toBeGreaterThan(0)
      expect(byEvent("SessionEnd")[0]).toMatchObject({
        agentId: MAIN,
        state: "done",
      })
    })

    it("maps run_in_background Bash to a background agent keyed by tool_use_id", () => {
      const pre = byEvent("PreToolUse").find((r) => r.toolUseId === BG_TOOL_USE)!
      expect(pre).toMatchObject({
        agentId: BG_TOOL_USE,
        parentAgentId: MAIN,
        role: "background",
        state: "working",
        tool: "Bash",
        task: "Run background command with 3 second delay",
      })
      expect(state.taskIds["bhz2jge9v"]).toBe(BG_TOOL_USE)
    })

    it("marks the background shell done from its task-notification", () => {
      const done = records.find((r) => r.agentId === BG_TOOL_USE && r.event === "UserPromptSubmit")!
      expect(done).toMatchObject({
        role: "background",
        state: "done",
        parentAgentId: MAIN,
      })
      expect(done.runtimeMs).toBeGreaterThan(0)
    })

    it("links the async subagent via PostToolUse(Agent).agentId before SubagentStart", () => {
      const start = byEvent("SubagentStart")[0]
      expect(start).toMatchObject({
        agentId: ASYNC_SUB,
        parentAgentId: MAIN,
        role: "subagent",
        state: "working",
        task: "List repo files",
        model: "claude-haiku-4-5-20251001",
        toolUseId: "toolu_01HmKFKytgo9XtoefJPxKH32",
      })
      const inner = records.find((r) => r.agentId === ASYNC_SUB && r.event === "PreToolUse")!
      expect(inner).toMatchObject({
        role: "subagent",
        parentAgentId: MAIN,
        tool: "Bash",
        state: "working",
      })
      expect(byEvent("SubagentStop")[0]).toMatchObject({
        agentId: ASYNC_SUB,
        state: "done",
        inputTokens: 1000,
      })
    })

    it("keeps a failing foreground tool as working for the calling agent", () => {
      expect(byEvent("PostToolUseFailure")[0]).toMatchObject({
        agentId: MAIN,
        state: "working",
        tool: "Bash",
      })
    })
  })

  describe("foreground subagent (SubagentStart before PostToolUse)", () => {
    const { records } = replay(loadFixture("foreground-subagent.jsonl"))

    it("links the subagent to its Agent tool call by subagent_type", () => {
      const start = records.find((r) => r.event === "SubagentStart")!
      expect(start).toMatchObject({
        agentId: FG_SUB,
        parentAgentId: records[0].agentId,
        task: "Count files",
        state: "working",
      })
      const post = records.find((r) => r.event === "PostToolUse" && r.tool === "Agent")!
      expect(post).toMatchObject({ role: "main", state: "working" })
      for (const r of records) expect(validate(r)).toEqual([])
    })
  })

  it("acceptance: main + two subagents + one background shell resolve to four agents with correct parents", () => {
    const state = initialObserverState()
    const first = loadFixture("background-and-async-subagent.jsonl").filter((e) => e.hook_event_name !== "SessionEnd")
    const second = loadFixture("foreground-subagent.jsonl")
      .filter((e) => !["SessionStart", "SessionEnd"].includes(String(e.hook_event_name)))
      .map((e) => ({ ...e, session_id: MAIN }))
    const { records } = replay([...first, ...second], state)

    const latest = new Map<string, AgentObservation>()
    for (const r of records) if (r.agentId) latest.set(r.agentId, r)
    expect([...latest.keys()].sort()).toEqual([ASYNC_SUB, FG_SUB, MAIN, BG_TOOL_USE].sort())
    expect(latest.get(MAIN)).toMatchObject({
      role: "main",
      parentAgentId: null,
      state: "done",
    })
    expect(latest.get(ASYNC_SUB)).toMatchObject({
      role: "subagent",
      parentAgentId: MAIN,
      state: "done",
    })
    expect(latest.get(FG_SUB)).toMatchObject({
      role: "subagent",
      parentAgentId: MAIN,
      state: "done",
    })
    expect(latest.get(BG_TOOL_USE)).toMatchObject({
      role: "background",
      parentAgentId: MAIN,
      state: "done",
    })
    for (const r of latest.values()) expect(r.runtimeMs).not.toBeNull()
  })
})

describe("agent-observer: mapping rules", () => {
  const base = { session_id: "s1", cwd: "/repo", transcript_path: "/t.jsonl" }

  it("Notification -> waiting (documented fields; not emitted in headless runs)", () => {
    const state = initialObserverState()
    const r = observe(
      {
        ...base,
        hook_event_name: "Notification",
        message: "Claude needs your permission",
        notification_type: "permission_prompt",
      },
      state,
      ctxAt(0),
    )!
    expect(r).toMatchObject({ agentId: "s1", role: "main", state: "waiting" })
    expect(JSON.stringify(r)).not.toContain("permission")
  })

  it("StopFailure -> failed", () => {
    const r = observe({ ...base, hook_event_name: "StopFailure" }, initialObserverState(), ctxAt(0))!
    expect(r).toMatchObject({ agentId: "s1", state: "failed" })
  })

  it("failed background shell notification -> failed", () => {
    const state = initialObserverState()
    observe(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tu1",
        tool_input: { command: "x", run_in_background: true },
      },
      state,
      ctxAt(0),
    )
    observe(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tu1",
        tool_input: {},
        tool_response: { backgroundTaskId: "b1" },
      },
      state,
      ctxAt(1),
    )
    const r = observe(
      {
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt: "<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n</task-notification>",
      },
      state,
      ctxAt(5000),
    )!
    expect(r).toMatchObject({
      agentId: "tu1",
      role: "background",
      state: "failed",
      runtimeMs: 5000,
    })
  })

  it("nested subagent: Agent call from inside a subagent sets that subagent as parent", () => {
    const state = initialObserverState()
    observe(
      {
        ...base,
        hook_event_name: "SubagentStart",
        agent_id: "sub1",
        agent_type: "Explore",
      },
      state,
      ctxAt(0),
    )
    observe(
      {
        ...base,
        hook_event_name: "PreToolUse",
        agent_id: "sub1",
        agent_type: "Explore",
        tool_name: "Agent",
        tool_use_id: "tu9",
        tool_input: {
          description: "nested",
          subagent_type: "general-purpose",
          prompt: "p",
        },
      },
      state,
      ctxAt(1),
    )
    const r = observe(
      {
        ...base,
        hook_event_name: "SubagentStart",
        agent_id: "sub2",
        agent_type: "general-purpose",
      },
      state,
      ctxAt(2),
    )!
    expect(r).toMatchObject({
      agentId: "sub2",
      parentAgentId: "sub1",
      task: "nested",
      toolUseId: "tu9",
    })
  })

  it("never writes tool input/output, prompt text beyond 120 chars, or secrets", () => {
    const state = initialObserverState()
    const secret = "sk-ant-SECRET-VALUE"
    const longPrompt = "Please deploy. " + "x".repeat(200) + secret
    const recs = [
      observe({ ...base, hook_event_name: "UserPromptSubmit", prompt: longPrompt }, state, ctxAt(0))!,
      observe(
        {
          ...base,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "t",
          tool_input: { command: `curl -H "x-api-key: ${secret}"` },
        },
        state,
        ctxAt(1),
      )!,
      observe(
        {
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "t",
          tool_input: { command: secret },
          tool_response: { stdout: secret, stderr: "" },
        },
        state,
        ctxAt(2),
      )!,
    ]
    const serialized = JSON.stringify(recs) + JSON.stringify(state)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("curl")
    expect(recs[0].task).toHaveLength(120)
    expect(recs[0].task!.endsWith("…")).toBe(true)
  })

  it("matches an Agent call without subagent_type to a general-purpose SubagentStart (observed live)", () => {
    const state = initialObserverState()
    observe(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "tuA",
        tool_input: { description: "Background lister", prompt: "p", run_in_background: true },
      },
      state,
      ctxAt(0),
    )
    const r = observe(
      { ...base, hook_event_name: "SubagentStart", agent_id: "subA", agent_type: "general-purpose" },
      state,
      ctxAt(1),
    )!
    expect(r).toMatchObject({ agentId: "subA", task: "Background lister", toolUseId: "tuA", parentAgentId: "s1" })
  })

  it("ignores payloads without hook_event_name", () => {
    expect(observe({}, initialObserverState(), ctxAt(0))).toBeNull()
  })
})

describe("agent-observer: adapter I/O", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-observer-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("resolves <project>/.nexus/claude/observer, honoring NEXUS_AGENTIC_ROOT", () => {
    expect(resolveObserverDir({ CLAUDE_PROJECT_DIR: "/p" }, {})).toBe("/p/.nexus/claude/observer")
    expect(resolveObserverDir({ CLAUDE_PROJECT_DIR: "/p", NEXUS_AGENTIC_ROOT: "agentic" }, {})).toBe(
      "/p/agentic/claude/observer",
    )
    // Bare cwd outside any git checkout is not a project root.
    expect(resolveObserverDir({}, { cwd: "/c" })).toBeNull()
  })

  it("does not create .nexus when the agentic root is missing", () => {
    const wrote = handleHookPayload({ hook_event_name: "SessionStart", session_id: "s" }, { CLAUDE_PROJECT_DIR: dir })
    expect(wrote).toBe(false)
    expect(existsSync(join(dir, ".nexus"))).toBe(false)
  })

  it("serializes concurrent hook processes so no state update is lost (built bundle)", async () => {
    mkdirSync(join(dir, ".nexus"))
    const bundle = join(import.meta.dirname, "../../../plugins/nexus-core/hooks/agent-observer.mjs")
    const run = (payload: object) =>
      new Promise<number>((resolveExit) => {
        const child = spawn(process.execPath, [bundle], {
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
          stdio: ["pipe", "ignore", "ignore"],
        })
        child.on("exit", (code) => resolveExit(code ?? -1))
        child.stdin.end(JSON.stringify(payload))
      })
    const n = 8
    const codes = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        run({
          hook_event_name: "PreToolUse",
          session_id: "s",
          cwd: dir,
          tool_name: "Agent",
          tool_use_id: `tu${i}`,
          tool_input: { description: `d${i}`, subagent_type: "general-purpose" },
        }),
      ),
    )
    expect(codes).toEqual(Array(n).fill(0))
    const state = JSON.parse(readFileSync(join(dir, ".nexus/claude/observer/state.json"), "utf-8"))
    expect(state.pending.map((p: { toolUseId: string }) => p.toolUseId).sort()).toEqual(
      Array.from({ length: n }, (_, i) => `tu${i}`).sort(),
    )
    expect(readFileSync(join(dir, ".nexus/claude/observer/events.jsonl"), "utf-8").trim().split("\n")).toHaveLength(n)
    expect(existsSync(join(dir, ".nexus/claude/observer/state.lock"))).toBe(false)
  })

  it("appends the record but does not save state when the lock is not acquired", () => {
    const observerDir = join(dir, ".nexus/claude/observer")
    mkdirSync(observerDir, { recursive: true })
    writeFileSync(join(observerDir, "state.lock"), "") // fresh lock held by another process
    const wrote = handleHookPayload(
      { hook_event_name: "SessionStart", session_id: "s", cwd: dir },
      { CLAUDE_PROJECT_DIR: dir },
    )
    expect(wrote).toBe(true)
    expect(readFileSync(join(observerDir, "events.jsonl"), "utf-8").trim().split("\n")).toHaveLength(1)
    expect(existsSync(join(observerDir, "state.json"))).toBe(false)
  })

  it("exits 0 on malformed stdin (built bundle)", async () => {
    const bundle = join(import.meta.dirname, "../../../plugins/nexus-core/hooks/agent-observer.mjs")
    const code = await new Promise<number>((resolveExit) => {
      const child = spawn(process.execPath, [bundle], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        stdio: ["pipe", "ignore", "ignore"],
      })
      child.on("exit", (c) => resolveExit(c ?? -1))
      child.stdin.end("{not json")
    })
    expect(code).toBe(0)
  })

  it("appends JSONL records and persists state under the observer dir", () => {
    mkdirSync(join(dir, ".nexus"))
    const env = { CLAUDE_PROJECT_DIR: dir }
    handleHookPayload({ hook_event_name: "SessionStart", session_id: "s", cwd: dir }, env)
    handleHookPayload(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s",
        cwd: dir,
        prompt: "hi",
      },
      env,
    )
    const lines = readFileSync(join(dir, ".nexus/claude/observer/events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => l.event)).toEqual(["SessionStart", "UserPromptSubmit"])
    expect(lines[1]).toMatchObject({
      schema: "nexus.agent-observation.v1",
      agentId: "s",
      task: "hi",
      state: "working",
    })
    expect(existsSync(join(dir, ".nexus/claude/observer/state.json"))).toBe(true)
  })
})

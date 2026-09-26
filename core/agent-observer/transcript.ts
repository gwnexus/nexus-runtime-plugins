import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { UsageCursor } from "./types.ts"

/**
 * Incremental token/model aggregation from a Claude Code transcript JSONL
 * (`transcript_path` / `agent_transcript_path`, both documented hook input
 * fields). Only bytes appended since the stored cursor offset are read, so a
 * long session costs one small read per Stop/SubagentStop rather than a full
 * re-parse. Only `message.id`, `message.model` and `message.usage` of
 * assistant lines are looked at; content is never retained.
 *
 * Input tokens = input + cache creation + cache read (all prompt tokens the
 * model processed). Claude Code writes one line per content block of a
 * streamed message, each repeating the message id and usage; the last line
 * for an id wins, including across reads (tracked via `lastMessageId`).
 */

/** Upper bound per invocation; the remainder is picked up next time. */
export const MAX_READ_BYTES = 16 * 1024 * 1024

export function emptyCursor(path: string): UsageCursor {
  return {
    path,
    offset: 0,
    lastMessageId: null,
    lastInput: 0,
    lastOutput: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
}

export interface UsageUpdate {
  cursor: UsageCursor
  /** Model of the most recent assistant message read in this pass, if any. */
  model: string | null
}

export function readUsageIncrement(
  path: string,
  previous: UsageCursor | null,
  opts: { skipSidechain?: boolean } = {},
): UsageUpdate {
  const cursor: UsageCursor = previous && previous.path === path ? { ...previous } : emptyCursor(path)
  let model: string | null = null
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    if (size < cursor.offset) Object.assign(cursor, emptyCursor(path)) // truncated/replaced
    const length = Math.min(size - cursor.offset, MAX_READ_BYTES)
    if (length <= 0) return { cursor, model }
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, cursor.offset)
    const lastNewline = buf.lastIndexOf(0x0a, read - 1)
    if (lastNewline < 0) return { cursor, model } // no complete line yet
    const text = buf.subarray(0, lastNewline).toString("utf-8")
    cursor.offset += lastNewline + 1

    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"')) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry?.type !== "assistant") continue
      if (opts.skipSidechain && entry.isSidechain === true) continue
      const msg = entry.message
      if (!msg || typeof msg !== "object") continue
      if (typeof msg.model === "string" && msg.model !== "<synthetic>") model = msg.model
      const usage = msg.usage
      if (!usage || typeof usage !== "object") continue
      const input =
        num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens)
      const output = num(usage.output_tokens)
      const id = typeof msg.id === "string" ? msg.id : null
      if (id !== null && id === cursor.lastMessageId) {
        cursor.inputTokens -= cursor.lastInput
        cursor.outputTokens -= cursor.lastOutput
      }
      cursor.inputTokens += input
      cursor.outputTokens += output
      cursor.lastMessageId = id
      cursor.lastInput = input
      cursor.lastOutput = output
    }
  } catch {
    // missing/unreadable transcript -- keep the previous cursor
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
  return { cursor, model }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
}

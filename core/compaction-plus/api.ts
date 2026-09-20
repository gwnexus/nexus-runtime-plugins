import type { NexusConfig } from "./types.ts"

/**
 * Append a compaction entry to the Nexus session via REST API (ADR-C05 core
 * module) — runtime-agnostic (fetch only). `onLog` lets each adapter route
 * the request/response trace to its own logger.
 */
export async function appendCompactionEntry(
  config: NexusConfig,
  sessionId: string,
  summary: string,
  onLog?: (level: "info" | "error", message: string) => void,
): Promise<void> {
  const url = `${config.apiUrl}/api/mcp/sessions`
  const payload = {
    action: "session_append",
    session_id: sessionId,
    entry_type: "compaction",
    summary,
  }

  onLog?.("info", `POST ${url} — payload: ${JSON.stringify(payload)}`)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
  })

  const body = await res.text().catch(() => "")
  onLog?.("info", `Response ${res.status}: ${body}`)

  if (!res.ok) {
    throw new Error(`Nexus API ${res.status}: ${body}`)
  }
}

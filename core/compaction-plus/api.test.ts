import { describe, it, expect, vi, beforeEach } from "vitest"
import { appendCompactionEntry } from "./api.ts"

describe("compaction-plus core api", () => {
  const config = { apiUrl: "https://nexus.example.com", token: "tok-123" }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("posts a session_append payload with entry_type=compaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    })
    vi.stubGlobal("fetch", fetchMock)

    await appendCompactionEntry(config, "sess-1", "summary text")

    expect(fetchMock).toHaveBeenCalledWith(
      "https://nexus.example.com/api/mcp/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok-123" }),
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({
      action: "session_append",
      session_id: "sess-1",
      entry_type: "compaction",
      summary: "summary text",
    })
  })

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "server error" }),
    )

    await expect(appendCompactionEntry(config, "sess-1", "summary")).rejects.toThrow("Nexus API 500")
  })

  it("calls onLog with request and response trace lines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" }))
    const onLog = vi.fn()

    await appendCompactionEntry(config, "sess-1", "summary", onLog)

    expect(onLog).toHaveBeenCalledWith("info", expect.stringContaining("POST"))
    expect(onLog).toHaveBeenCalledWith("info", expect.stringContaining("Response 200"))
  })
})

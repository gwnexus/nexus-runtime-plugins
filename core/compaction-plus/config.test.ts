import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not found")
    }),
  }
})

import { getNexusConfig } from "./config.ts"

describe("compaction-plus core config", () => {
  const prevApiUrl = process.env.NEXUS_API_URL
  const prevToken = process.env.NEXUS_PRIVATE_TOKEN

  beforeEach(() => {
    delete process.env.NEXUS_API_URL
    delete process.env.NEXUS_PRIVATE_TOKEN
  })

  afterAll(() => {
    if (prevApiUrl !== undefined) process.env.NEXUS_API_URL = prevApiUrl
    if (prevToken !== undefined) process.env.NEXUS_PRIVATE_TOKEN = prevToken
  })

  it("resolves from environment variables when both are set", () => {
    process.env.NEXUS_API_URL = "https://nexus.example.com"
    process.env.NEXUS_PRIVATE_TOKEN = "tok-123"
    const config = getNexusConfig("/tmp/project")
    expect(config).toEqual({ apiUrl: "https://nexus.example.com", token: "tok-123" })
  })

  it("returns null when no env vars and no global config files exist", () => {
    const config = getNexusConfig("/tmp/project")
    expect(config).toBeNull()
  })
})

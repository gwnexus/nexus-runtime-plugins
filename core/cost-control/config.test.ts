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

import { getNexusConfig, getHeliconeConfig } from "./config.ts"

describe("cost-control core config", () => {
  const prevApiUrl = process.env.NEXUS_API_URL
  const prevToken = process.env.NEXUS_PRIVATE_TOKEN
  const prevHelicone = process.env.HELICONE_API_KEY

  beforeEach(() => {
    delete process.env.NEXUS_API_URL
    delete process.env.NEXUS_PRIVATE_TOKEN
    delete process.env.HELICONE_API_KEY
  })

  afterAll(() => {
    if (prevApiUrl !== undefined) process.env.NEXUS_API_URL = prevApiUrl
    if (prevToken !== undefined) process.env.NEXUS_PRIVATE_TOKEN = prevToken
    if (prevHelicone !== undefined) process.env.HELICONE_API_KEY = prevHelicone
  })

  it("resolves Nexus config from environment variables", () => {
    process.env.NEXUS_API_URL = "https://nexus.example.com"
    process.env.NEXUS_PRIVATE_TOKEN = "tok-123"
    expect(getNexusConfig("/tmp/project")).toEqual({ apiUrl: "https://nexus.example.com", token: "tok-123" })
  })

  it("returns null Nexus config when nothing is configured", () => {
    expect(getNexusConfig("/tmp/project")).toBeNull()
  })

  it("resolves Helicone config from HELICONE_API_KEY", () => {
    process.env.HELICONE_API_KEY = "sk-helicone-123"
    expect(getHeliconeConfig("/tmp/project")).toEqual({ apiKey: "sk-helicone-123" })
  })

  it("returns null Helicone config when nothing is configured", () => {
    expect(getHeliconeConfig("/tmp/project")).toBeNull()
  })
})

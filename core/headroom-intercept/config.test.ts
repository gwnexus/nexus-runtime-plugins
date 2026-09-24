import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

const fsState = {
  existing: new Set<string>(),
  contents: new Map<string, string>(),
}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn((path: string) => fsState.existing.has(path)),
    readFileSync: vi.fn((path: string) => {
      const content = fsState.contents.get(path)
      if (content === undefined) throw new Error(`not found: ${path}`)
      return content
    }),
  }
})

import { getNexusConfig } from "./config.ts"

const DIR = "/tmp/project"
const MCP_JSON = `${DIR}/.mcp.json`
const OPENCODE_JSON = `${DIR}/opencode.json`
const PROJECT_CONFIG = `${DIR}/.nexus/config.toml`
const PROJECT_CREDS = `${DIR}/.nexus/credentials.toml`
const GLOBAL_CONFIG = "/home/tester/.config/nexus/config.toml"
const GLOBAL_CREDS = "/home/tester/.config/nexus/credentials.toml"

function setFile(path: string, content: string) {
  fsState.existing.add(path)
  fsState.contents.set(path, content)
}

describe("headroom-intercept core config resolution order", () => {
  const prevApiUrl = process.env.NEXUS_API_URL
  const prevToken = process.env.NEXUS_PRIVATE_TOKEN
  const prevHome = process.env.HOME

  beforeEach(() => {
    delete process.env.NEXUS_API_URL
    delete process.env.NEXUS_PRIVATE_TOKEN
    process.env.HOME = "/home/tester"
    fsState.existing.clear()
    fsState.contents.clear()
  })

  afterAll(() => {
    if (prevApiUrl !== undefined) process.env.NEXUS_API_URL = prevApiUrl
    if (prevToken !== undefined) process.env.NEXUS_PRIVATE_TOKEN = prevToken
    if (prevHome !== undefined) process.env.HOME = prevHome
  })

  it("resolves from environment variables first", () => {
    process.env.NEXUS_API_URL = "https://env.example.com"
    process.env.NEXUS_PRIVATE_TOKEN = "env-token"
    setFile(MCP_JSON, JSON.stringify({ mcpServers: { nexus: { env: { NEXUS_API_URL: "https://mcp.example.com", NEXUS_PRIVATE_TOKEN: "mcp-token" } } } }))
    const config = getNexusConfig(DIR)
    expect(config).toEqual({ apiUrl: "https://env.example.com", token: "env-token", source: "env" })
  })

  it("resolves from .mcp.json when env vars are absent", () => {
    setFile(MCP_JSON, JSON.stringify({ mcpServers: { nexus: { env: { NEXUS_API_URL: "https://staging.example.com", NEXUS_PRIVATE_TOKEN: "staging-token" } } } }))
    const config = getNexusConfig(DIR)
    expect(config).toEqual({ apiUrl: "https://staging.example.com", token: "staging-token", source: ".mcp.json" })
  })

  it("falls back to opencode.json when .mcp.json is absent", () => {
    setFile(OPENCODE_JSON, JSON.stringify({ mcp: { nexus: { environment: { NEXUS_API_URL: "https://oc.example.com", NEXUS_PRIVATE_TOKEN: "oc-token" } } } }))
    const config = getNexusConfig(DIR)
    expect(config).toEqual({ apiUrl: "https://oc.example.com", token: "oc-token", source: "opencode.json" })
  })

  it("falls back to project-local .nexus/config.toml + credentials.toml when no .mcp.json/opencode.json", () => {
    setFile(PROJECT_CONFIG, 'api_url = "https://project-local.example.com"\n')
    setFile(PROJECT_CREDS, 'token = "project-local-token"\n')
    const config = getNexusConfig(DIR)
    expect(config).toEqual({ apiUrl: "https://project-local.example.com", token: "project-local-token", source: "project-local-config" })
  })

  it("prefers project-local config over global config (staging vs prod fix)", () => {
    setFile(PROJECT_CONFIG, 'api_url = "https://staging.example.com"\n')
    setFile(PROJECT_CREDS, 'token = "staging-token"\n')
    setFile(GLOBAL_CONFIG, 'api_url = "https://prod.example.com"\n')
    setFile(GLOBAL_CREDS, 'token = "prod-token"\n')
    const config = getNexusConfig(DIR)
    expect(config).toEqual({ apiUrl: "https://staging.example.com", token: "staging-token", source: "project-local-config" })
  })

  it("falls back to global config as last resort", () => {
    setFile(GLOBAL_CONFIG, 'api_url = "https://prod.example.com"\n')
    setFile(GLOBAL_CREDS, 'token = "prod-token"\n')
    const config = getNexusConfig(DIR)
    expect(config).toEqual({ apiUrl: "https://prod.example.com", token: "prod-token", source: "global-config" })
  })

  it("returns null when no source resolves", () => {
    const config = getNexusConfig(DIR)
    expect(config).toBeNull()
  })
})

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isSecureApiUrl, resolveNexusConfig } from "./nexus-config.ts"

let base: string
let project: string
let home: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nx-config-"))
  project = join(base, "project")
  home = join(base, "home")
  mkdirSync(join(project, ".nexus"), { recursive: true })
  mkdirSync(join(home, ".config", "nexus"), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const env = () => ({ HOME: home })

function projectToml(url: string | null, token: string | null) {
  if (url !== null) writeFileSync(join(project, ".nexus", "config.toml"), `[project]\nid = "p"\napi_url = "${url}"\n`)
  if (token !== null) writeFileSync(join(project, ".nexus", "credentials.toml"), `token = "${token}"\n`)
}
function globalToml(url: string, token: string) {
  writeFileSync(join(home, ".config", "nexus", "config.toml"), `api_url = "${url}"\n`)
  writeFileSync(join(home, ".config", "nexus", "credentials.toml"), `token = "${token}"\n`)
}
function mcpJson(url: string, token: string) {
  writeFileSync(
    join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { nexus: { env: { NEXUS_API_URL: url, NEXUS_PRIVATE_TOKEN: token } } } }),
  )
}

describe("resolveNexusConfig", () => {
  it("prefers env over every file source", () => {
    projectToml("https://staging.example", "staging-token")
    expect(
      resolveNexusConfig(project, { ...env(), NEXUS_API_URL: "https://env.example", NEXUS_PRIVATE_TOKEN: "env-token" }),
    ).toEqual({ apiUrl: "https://env.example", token: "env-token", source: "env" })
  })

  it("falls through a URL-only env to a later source on the same API", () => {
    globalToml("https://env.example/", "global-token")
    expect(resolveNexusConfig(project, { ...env(), NEXUS_API_URL: "https://env.example" })).toEqual({
      apiUrl: "https://env.example/",
      token: "global-token",
      source: "global",
    })
  })

  it("pins a URL-only env: pairs a project token with the env host", () => {
    projectToml(null, "file-token")
    mcpJson("https://prod.example", "prod-token")
    expect(resolveNexusConfig(project, { ...env(), NEXUS_API_URL: "https://staging.example" })).toEqual({
      apiUrl: "https://staging.example",
      token: "file-token",
      source: "project",
    })
  })

  it("pins a URL-only env: skips pairs that point at another API", () => {
    projectToml("https://prod.example", "project-token")
    mcpJson("https://prod.example", "mcp-token")
    globalToml("https://prod.example", "prod-token")
    const pinnedEnv = { ...env(), NEXUS_API_URL: "https://staging.example" }
    expect(resolveNexusConfig(project, pinnedEnv)).toBeNull()
    mcpJson("https://STAGING.example/", "mcp-token")
    expect(resolveNexusConfig(project, pinnedEnv)).toEqual({
      apiUrl: "https://STAGING.example/",
      token: "mcp-token",
      source: "mcp",
    })
  })

  it("prefers project-local over .mcp.json and global", () => {
    projectToml("https://staging.example", "staging-token")
    mcpJson("https://staging.example", "mcp-token")
    globalToml("https://prod.example", "prod-token")
    expect(resolveNexusConfig(project, env())).toEqual({
      apiUrl: "https://staging.example",
      token: "staging-token",
      source: "project",
    })
  })

  it("uses .mcp.json, then opencode.json, then global", () => {
    globalToml("https://prod.example", "prod-token")
    expect(resolveNexusConfig(project, env())?.source).toBe("global")
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({
        mcp: { nexus: { environment: { NEXUS_API_URL: "https://oc.example", NEXUS_PRIVATE_TOKEN: "t" } } },
      }),
    )
    expect(resolveNexusConfig(project, env())?.source).toBe("opencode")
    mcpJson("https://mcp.example", "mcp-token")
    expect(resolveNexusConfig(project, env())).toEqual({
      apiUrl: "https://mcp.example",
      token: "mcp-token",
      source: "mcp",
    })
  })

  it("never pairs a project URL with another source's token", () => {
    projectToml("https://staging.example", null)
    globalToml("https://prod.example", "prod-token")
    expect(resolveNexusConfig(project, env())).toBeNull()
  })

  it("accepts a later source when it points at the project's pinned API", () => {
    projectToml("https://staging.example/", null)
    mcpJson("https://prod.example", "prod-token")
    globalToml("https://STAGING.example", "staging-global-token")
    expect(resolveNexusConfig(project, env())).toEqual({
      apiUrl: "https://STAGING.example",
      token: "staging-global-token",
      source: "global",
    })
  })

  it("pairs a token-only later source with the project's pinned API", () => {
    projectToml("https://staging.example", null)
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { nexus: { env: { NEXUS_PRIVATE_TOKEN: "mcp-token" } } } }),
    )
    expect(resolveNexusConfig(project, env())).toEqual({
      apiUrl: "https://staging.example",
      token: "mcp-token",
      source: "mcp",
    })
  })

  it("pairs a token-only env with the project's pinned API", () => {
    projectToml("https://staging.example", null)
    mcpJson("https://staging.example", "mcp-token")
    expect(resolveNexusConfig(project, { ...env(), NEXUS_PRIVATE_TOKEN: "env-token" })).toEqual({
      apiUrl: "https://staging.example",
      token: "env-token",
      source: "env",
    })
  })

  it("still skips a later source with a conflicting URL when a token-only source follows", () => {
    projectToml("https://staging.example", null)
    mcpJson("https://prod.example", "prod-token")
    writeFileSync(join(home, ".config", "nexus", "credentials.toml"), `token = "global-token"\n`)
    expect(resolveNexusConfig(project, env())).toEqual({
      apiUrl: "https://staging.example",
      token: "global-token",
      source: "global",
    })
  })

  it("skips a token-only source when no API is pinned", () => {
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { nexus: { env: { NEXUS_PRIVATE_TOKEN: "mcp-token" } } } }),
    )
    expect(resolveNexusConfig(project, { ...env(), NEXUS_PRIVATE_TOKEN: "env-token" })).toBeNull()
    globalToml("https://prod.example", "prod-token")
    expect(resolveNexusConfig(project, env())?.source).toBe("global")
  })

  it("treats missing files, malformed TOML/JSON and placeholders as absent", () => {
    writeFileSync(join(project, ".nexus", "config.toml"), "api_url = staging.example\n[[[")
    writeFileSync(join(project, ".nexus", "credentials.toml"), "token = \n")
    writeFileSync(join(project, ".mcp.json"), "{ not json")
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({
        mcp: { nexus: { environment: { NEXUS_API_URL: "${NEXUS_API_URL}", NEXUS_PRIVATE_TOKEN: "${TOKEN}" } } },
      }),
    )
    expect(resolveNexusConfig(project, env())).toBeNull()
    expect(resolveNexusConfig(join(base, "missing"), { HOME: join(base, "nohome") })).toBeNull()
    globalToml("https://prod.example", "prod-token")
    expect(resolveNexusConfig(project, env())?.source).toBe("global")
  })

  it("never sends the token over plain http to a non-loopback host", () => {
    expect(
      resolveNexusConfig(project, { ...env(), NEXUS_API_URL: "http://api.example", NEXUS_PRIVATE_TOKEN: "env-token" }),
    ).toBeNull()
    projectToml("http://staging.example", "project-token")
    globalToml("https://staging.example", "global-token")
    // An insecure pinned URL disables resolution instead of falling through.
    expect(resolveNexusConfig(project, env())).toBeNull()
  })

  it("skips a later source with an insecure URL and uses the next one", () => {
    mcpJson("http://mcp.example", "mcp-token")
    globalToml("https://prod.example", "prod-token")
    expect(resolveNexusConfig(project, env())).toEqual({
      apiUrl: "https://prod.example",
      token: "prod-token",
      source: "global",
    })
  })

  it("allows plain http for loopback hosts", () => {
    expect(
      resolveNexusConfig(project, { ...env(), NEXUS_API_URL: "http://127.0.0.1:4000", NEXUS_PRIVATE_TOKEN: "t" })?.source,
    ).toBe("env")
  })
})

describe("isSecureApiUrl", () => {
  it.each([
    ["https://api.example", true],
    ["HTTPS://API.EXAMPLE/", true],
    ["http://localhost:3000", true],
    ["http://app.localhost", true],
    ["http://127.0.0.1:8080", true],
    ["http://127.1.2.3", true],
    ["http://[::1]:4000", true],
    ["http://api.example", false],
    ["http://127.0.0.1.evil.example", false],
    ["http://localhost.evil.example", false],
    ["ftp://api.example", false],
    ["api.example", false],
    ["", false],
  ])("%s -> %s", (url, ok) => {
    expect(isSecureApiUrl(url)).toBe(ok)
  })
})

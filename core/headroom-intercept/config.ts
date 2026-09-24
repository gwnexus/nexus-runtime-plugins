import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { NexusConfig, ProjectContext } from "./types.ts"

/**
 * Nexus credential/project-context resolution (ADR-C05 core module) —
 * runtime-agnostic (fs + fetch only, no runtime-specific SDK calls).
 *
 * Credential source drift fix (v0.5.15, Fix §2, Dispatch 0e38cf7b):
 * resolution order is
 *   1. process.env.NEXUS_API_URL / NEXUS_PRIVATE_TOKEN (explicit override)
 *   2. <directory>/.mcp.json mcpServers.nexus.env (Claude Code project
 *      config, the Claude analogue of opencode.json)
 *   3. <directory>/opencode.json mcp.nexus.environment (OpenCode project
 *      config; per `nexus init`/`nexus pull` this file may also exist in
 *      Claude Code projects as an equivalent project config)
 *   4. <directory>/.nexus/config.toml + .nexus/credentials.toml
 *      (project-local, nexus-cli >= 0.2x default — takes precedence over
 *      the global config so a project linked to e.g. staging is not
 *      silently resolved against the user's global/prod credentials)
 *   5. ~/.config/nexus/config.toml + credentials.toml (global CLI login)
 *
 * This resolution order was originally OpenCode-specific in name only
 * (opencode.json is the project config file for both OpenCode and, per
 * `nexus init`/`nexus pull`, an equivalent project config for Claude Code
 * projects) — it does not depend on any OpenCode runtime API, so it is
 * safe to share unchanged between adapters.
 */

function readMcpJsonNexusCreds(directory: string): Partial<NexusConfig> {
  try {
    const mcpPath = join(directory, ".mcp.json")
    if (!existsSync(mcpPath)) return {}
    const raw = readFileSync(mcpPath, "utf-8")
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>
    }
    const env = parsed.mcpServers?.nexus?.env ?? {}
    const apiUrl = typeof env.NEXUS_API_URL === "string" ? env.NEXUS_API_URL : undefined
    const token = typeof env.NEXUS_PRIVATE_TOKEN === "string" ? env.NEXUS_PRIVATE_TOKEN : undefined
    return { apiUrl, token }
  } catch {
    return {}
  }
}

function readProjectLocalTomlCreds(directory: string): Partial<NexusConfig> {
  try {
    const nexusDir = join(directory, ".nexus")
    const configPath = join(nexusDir, "config.toml")
    const credsPath = join(nexusDir, "credentials.toml")
    let apiUrl: string | undefined
    let token: string | undefined
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8")
      const m = raw.match(/api_url\s*=\s*"([^"]+)"/)
      if (m) apiUrl = m[1]
    }
    if (existsSync(credsPath)) {
      const raw = readFileSync(credsPath, "utf-8")
      const m = raw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (m) token = m[1]
    }
    return { apiUrl, token }
  } catch {
    return {}
  }
}

function readOpencodeJsonNexusCreds(directory: string): Partial<NexusConfig> {
  try {
    const ocPath = join(directory, "opencode.json")
    if (!existsSync(ocPath)) return {}
    const raw = readFileSync(ocPath, "utf-8")
    const parsed = JSON.parse(raw) as {
      mcp?: Record<string, { environment?: Record<string, string> }>
    }
    const env = parsed.mcp?.nexus?.environment ?? {}
    const apiUrl = typeof env.NEXUS_API_URL === "string" ? env.NEXUS_API_URL : undefined
    const token = typeof env.NEXUS_PRIVATE_TOKEN === "string" ? env.NEXUS_PRIVATE_TOKEN : undefined
    return { apiUrl, token }
  } catch {
    return {}
  }
}

export function getNexusConfig(directory: string): NexusConfig | null {
  let resolvedUrl = process.env.NEXUS_API_URL
  let resolvedToken = process.env.NEXUS_PRIVATE_TOKEN
  let source = "env"
  if (resolvedUrl && resolvedToken) {
    return { apiUrl: resolvedUrl, token: resolvedToken, source }
  }

  const mcpCreds = readMcpJsonNexusCreds(directory)
  if (!resolvedUrl && mcpCreds.apiUrl) {
    resolvedUrl = mcpCreds.apiUrl
    source = ".mcp.json"
  }
  if (!resolvedToken && mcpCreds.token) {
    resolvedToken = mcpCreds.token
    source = ".mcp.json"
  }
  if (resolvedUrl && resolvedToken) {
    return { apiUrl: resolvedUrl, token: resolvedToken, source }
  }

  const ocCreds = readOpencodeJsonNexusCreds(directory)
  if (!resolvedUrl && ocCreds.apiUrl) {
    resolvedUrl = ocCreds.apiUrl
    source = "opencode.json"
  }
  if (!resolvedToken && ocCreds.token) {
    resolvedToken = ocCreds.token
    source = "opencode.json"
  }
  if (resolvedUrl && resolvedToken) {
    return { apiUrl: resolvedUrl, token: resolvedToken, source }
  }

  const projectCreds = readProjectLocalTomlCreds(directory)
  if (!resolvedUrl && projectCreds.apiUrl) {
    resolvedUrl = projectCreds.apiUrl
    source = "project-local-config"
  }
  if (!resolvedToken && projectCreds.token) {
    resolvedToken = projectCreds.token
    source = "project-local-config"
  }
  if (resolvedUrl && resolvedToken) {
    return { apiUrl: resolvedUrl, token: resolvedToken, source }
  }

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const configDir = join(home, ".config", "nexus")
    const configPath = join(configDir, "config.toml")
    const credsPath = join(configDir, "credentials.toml")
    if (!resolvedUrl && existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8")
      const m = raw.match(/api_url\s*=\s*"([^"]+)"/)
      if (m) {
        resolvedUrl = m[1]
        source = "global-config"
      }
    }
    if (!resolvedToken && existsSync(credsPath)) {
      const raw = readFileSync(credsPath, "utf-8")
      const m = raw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (m) {
        resolvedToken = m[1]
        source = "global-config"
      }
    }
    if (resolvedUrl && resolvedToken) return { apiUrl: resolvedUrl, token: resolvedToken, source } as NexusConfig
  } catch {}
  return null
}

export function readProjectIdFromAgentsMd(directory: string): string | null {
  try {
    const agentsPath = join(directory, ".nexus", "AGENTS.md")
    if (!existsSync(agentsPath)) return null
    const raw = readFileSync(agentsPath, "utf-8")
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch) return null
    const pidMatch = fmMatch[1].match(/project_id:\s*([0-9a-f-]{36})/)
    return pidMatch ? pidMatch[1] : null
  } catch {
    return null
  }
}

export async function fetchProjectContext(config: NexusConfig, projectId: string): Promise<ProjectContext | null> {
  try {
    const res = await fetch(`${config.apiUrl}/api/mcp/projects/${projectId}/preflight`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { plugins?: unknown }
    const plugins: string[] = Array.isArray(data.plugins) ? (data.plugins as string[]) : []
    return { projectId, plugins, headroomEnabled: plugins.includes("headroom") }
  } catch {
    return null
  }
}

import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Nexus API URL and token resolution shared by all adapters (fs only).
 *
 * Order (first complete source wins):
 *   1. env      NEXUS_API_URL + NEXUS_PRIVATE_TOKEN
 *   2. project  <dir>/.nexus/config.toml (api_url) + <dir>/.nexus/credentials.toml (token),
 *               written by `nexus link` / `nexus pull`
 *   3. mcp      <dir>/.mcp.json mcpServers.nexus.env
 *   4. opencode <dir>/opencode.json mcp.nexus.environment
 *   5. global   ~/.config/nexus/config.toml + credentials.toml
 *
 * A source counts only when it yields both URL and token; fields are never
 * mixed across sources, so a token is only ever sent to the API it was
 * configured with. When the project-local config pins an `api_url`, later
 * sources are accepted only if they point at that same API, so a project
 * linked to e.g. staging never falls through to production credentials.
 * Hooks run outside `nexus run`, so the env source is usually absent.
 */

export type NexusConfigSource = "env" | "project" | "mcp" | "opencode" | "global"

export interface ResolvedNexusConfig {
  apiUrl: string
  token: string
  source: NexusConfigSource
}

interface Candidate {
  apiUrl?: string
  token?: string
}

export function resolveNexusConfig(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedNexusConfig | null {
  const fromEnv = { apiUrl: nonEmpty(env.NEXUS_API_URL), token: nonEmpty(env.NEXUS_PRIVATE_TOKEN) }
  if (fromEnv.apiUrl && fromEnv.token) return { apiUrl: fromEnv.apiUrl, token: fromEnv.token, source: "env" }

  const project = readTomlPair(join(directory, ".nexus"))
  const pinnedUrl = project.apiUrl ? normalizeUrl(project.apiUrl) : null
  if (project.apiUrl && project.token) return { apiUrl: project.apiUrl, token: project.token, source: "project" }

  const home = env.HOME ?? env.USERPROFILE ?? ""
  const later: Array<[NexusConfigSource, () => Candidate]> = [
    ["mcp", () => readJsonEnv(join(directory, ".mcp.json"), (j) => j?.mcpServers?.nexus?.env)],
    ["opencode", () => readJsonEnv(join(directory, "opencode.json"), (j) => j?.mcp?.nexus?.environment)],
    ["global", () => (home ? readTomlPair(join(home, ".config", "nexus")) : {})],
  ]
  for (const [source, read] of later) {
    const c = read()
    if (!c.apiUrl || !c.token) continue
    if (pinnedUrl && normalizeUrl(c.apiUrl) !== pinnedUrl) continue
    return { apiUrl: c.apiUrl, token: c.token, source }
  }
  return null
}

/** `config.toml` `api_url` + `credentials.toml` `token` from one directory. */
function readTomlPair(dir: string): Candidate {
  return {
    apiUrl: readTomlString(join(dir, "config.toml"), "api_url"),
    token: readTomlString(join(dir, "credentials.toml"), "token"),
  }
}

function readTomlString(path: string, key: string): string | undefined {
  try {
    const m = readFileSync(path, "utf-8").match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"))
    return m ? nonEmpty(m[1]) : undefined
  } catch {
    return undefined
  }
}

function readJsonEnv(path: string, pick: (json: any) => unknown): Candidate {
  try {
    const block = pick(JSON.parse(readFileSync(path, "utf-8")))
    if (typeof block !== "object" || block === null) return {}
    const e = block as Record<string, unknown>
    return {
      apiUrl: typeof e.NEXUS_API_URL === "string" ? nonEmpty(e.NEXUS_API_URL) : undefined,
      token: typeof e.NEXUS_PRIVATE_TOKEN === "string" ? nonEmpty(e.NEXUS_PRIVATE_TOKEN) : undefined,
    }
  } catch {
    return {}
  }
}

/** Trimmed value, or undefined when empty or an unexpanded `${VAR}` placeholder. */
function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t && !t.startsWith("${") ? t : undefined
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase()
}

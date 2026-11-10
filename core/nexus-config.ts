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
 * A source counts only when it yields both URL and token; a URL from one
 * source is never combined with a token configured for another API. An
 * `api_url` pins the API: `NEXUS_API_URL` from the environment (even without a
 * token), otherwise the project-local `api_url`. Later sources, the project
 * pair included, are then accepted only if they point at that same API, so a
 * developer who selected e.g. staging never falls through to production
 * credentials. The one exception: a later source that carries a token but no
 * URL (e.g. a project `credentials.toml` without `api_url`, or
 * NEXUS_PRIVATE_TOKEN without NEXUS_API_URL) is paired with the pinned URL,
 * but only when the operator approved that URL. Without an approved pinned
 * URL it is skipped.
 *
 * Operator approval: `.nexus/config.toml` is part of the checked-out
 * repository, so its `api_url` is repository-controlled. Pairing it with a
 * token from another source (environment, `.mcp.json`, `opencode.json`,
 * global config) would let a repository route the developer's token to a
 * host of its choice. Such a cross-source pair is used only when the pinned
 * URL comes from `NEXUS_API_URL`, or its origin (scheme, host, port) is
 * approved by the operator: the `api_url` of the global
 * `~/.config/nexus/config.toml`, or an entry of `NEXUS_TRUSTED_API_URLS`
 * (comma-separated). A source that carries both URL and token (the project's
 * own `config.toml` + `credentials.toml`, or `.mcp.json` with both) is a
 * same-source pair and needs no approval.
 * Hooks run outside `nexus run`, so the env source is usually absent.
 *
 * Transport: the token is a bearer credential, so only `https://` API URLs
 * are used; plain `http://` is accepted for loopback hosts only (local
 * development, tests). A pinned URL that fails this check disables the
 * resolution entirely (null) rather than falling through to another API; a
 * later source with an insecure URL is skipped.
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
  if (fromEnv.apiUrl && fromEnv.token) {
    return isSecureApiUrl(fromEnv.apiUrl) ? { apiUrl: fromEnv.apiUrl, token: fromEnv.token, source: "env" } : null
  }

  const project = readTomlPair(join(directory, ".nexus"))
  const pinned = fromEnv.apiUrl ?? project.apiUrl
  if (pinned && !isSecureApiUrl(pinned)) return null
  const pinnedUrl = pinned ? normalizeUrl(pinned) : null

  const home = env.HOME ?? env.USERPROFILE ?? ""
  const global = home ? readTomlPair(join(home, ".config", "nexus")) : {}
  // A token from one source may only travel to a URL from another source
  // when the operator chose or approved that URL (see header).
  const pinnedApproved =
    !!pinned && (!!fromEnv.apiUrl || approvedOrigins(env, global.apiUrl).has(urlOrigin(pinned) ?? ""))
  const later: Array<[NexusConfigSource, () => Candidate]> = [
    ["project", () => project],
    ["env", () => fromEnv],
    ["mcp", () => readJsonEnv(join(directory, ".mcp.json"), (j) => j?.mcpServers?.nexus?.env)],
    ["opencode", () => readJsonEnv(join(directory, "opencode.json"), (j) => j?.mcp?.nexus?.environment)],
    ["global", () => global],
  ]
  for (const [source, read] of later) {
    const c = read()
    if (!c.token) continue
    if (!c.apiUrl) {
      // Token-only source: usable only with an operator-approved pinned API.
      if (pinned && pinnedApproved) return { apiUrl: pinned, token: c.token, source }
      continue
    }
    if (pinnedUrl && normalizeUrl(c.apiUrl) !== pinnedUrl) continue
    if (!isSecureApiUrl(c.apiUrl)) continue
    return { apiUrl: c.apiUrl, token: c.token, source }
  }
  return null
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/**
 * True for `https://` URLs, and for `http://` URLs whose host is loopback
 * (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`). Anything else, including
 * unparsable values, is rejected: the token must not travel in clear text.
 */
export function isSecureApiUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  if (parsed.protocol === "https:") return true
  if (parsed.protocol !== "http:") return false
  const host = parsed.hostname.toLowerCase()
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host)
}

/** `scheme://host[:port]` of a URL, lower-cased; null when unparsable. */
function urlOrigin(url: string): string | null {
  try {
    return new URL(url.trim()).origin.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Origins the operator approved for cross-source token pairing: the global
 * config's `api_url` and every entry of `NEXUS_TRUSTED_API_URLS`. Both live
 * outside the repository.
 */
export function approvedOrigins(env: NodeJS.ProcessEnv, globalApiUrl?: string): Set<string> {
  const urls = [globalApiUrl ?? "", ...(env.NEXUS_TRUSTED_API_URLS ?? "").split(",")]
  const out = new Set<string>()
  for (const u of urls) {
    const o = u.trim() ? urlOrigin(u) : null
    if (o && o !== "null") out.add(o)
  }
  return out
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

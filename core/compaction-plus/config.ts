import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { NexusConfig } from "./types.ts"

/**
 * Nexus credential resolution (ADR-C05 core module) — runtime-agnostic
 * (fs only, no runtime-specific SDK calls). Unchanged behavior from the
 * original plugin: env vars first, then the global Nexus CLI login files.
 * Deliberately does NOT fall back to project-local opencode.json (unlike
 * headroom-intercept's resolver) — this mirrors the original per-plugin
 * implementation and was not unified during the ADR-C05 extraction to
 * avoid an unintended behavior change; revisit if the two should be
 * unified later.
 */
export function getNexusConfig(_directory: string): NexusConfig | null {
  const apiUrl = process.env.NEXUS_API_URL
  const token = process.env.NEXUS_PRIVATE_TOKEN
  if (apiUrl && token) return { apiUrl, token }

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const nexusConfigDir = join(home, ".config", "nexus")

    let resolvedApiUrl: string | undefined
    try {
      const configRaw = readFileSync(join(nexusConfigDir, "config.toml"), "utf-8")
      const apiMatch = configRaw.match(/^\s*api_url\s*=\s*"([^"]+)"/m)
      if (apiMatch) resolvedApiUrl = apiMatch[1]
    } catch {
      // config.toml not found
    }

    let resolvedToken: string | undefined
    try {
      const credsRaw = readFileSync(join(nexusConfigDir, "credentials.toml"), "utf-8")
      const tokenMatch = credsRaw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (tokenMatch) resolvedToken = tokenMatch[1]
    } catch {
      // credentials.toml not found
    }

    if (resolvedApiUrl && resolvedToken) {
      return { apiUrl: resolvedApiUrl, token: resolvedToken }
    }
  } catch {
    // ~/.config/nexus not accessible
  }

  return null
}

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { NexusConfig, HeliconeConfig } from "./types.ts"

/**
 * Nexus and Helicone credential resolution (ADR-C05 core module) —
 * runtime-agnostic (fs only). Unchanged behavior from the original plugin.
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
      const raw = readFileSync(join(nexusConfigDir, "config.toml"), "utf-8")
      const m = raw.match(/^\s*api_url\s*=\s*"([^"]+)"/m)
      if (m) resolvedApiUrl = m[1]
    } catch {
      /* not found */
    }

    let resolvedToken: string | undefined
    try {
      const raw = readFileSync(join(nexusConfigDir, "credentials.toml"), "utf-8")
      const m = raw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (m) resolvedToken = m[1]
    } catch {
      /* not found */
    }

    if (resolvedApiUrl && resolvedToken) {
      return { apiUrl: resolvedApiUrl, token: resolvedToken }
    }
  } catch {
    /* ~/.config/nexus not accessible */
  }

  return null
}

/**
 * Read Helicone API key from HELICONE_API_KEY env var. The key can also be
 * set in ~/.config/nexus/config.toml as: helicone_api_key = "sk-helicone-..."
 */
export function getHeliconeConfig(_directory: string): HeliconeConfig | null {
  const apiKey = process.env.HELICONE_API_KEY
  if (apiKey) return { apiKey }

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const configPath = join(home, ".config", "nexus", "config.toml")
    const raw = readFileSync(configPath, "utf-8")
    const m = raw.match(/^\s*helicone_api_key\s*=\s*"([^"]+)"/m)
    if (m) return { apiKey: m[1] }
  } catch {
    /* not found */
  }

  return null
}

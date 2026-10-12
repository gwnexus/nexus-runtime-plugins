import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveNexusConfig } from "../nexus-config.ts"
import type { NexusConfig, HeliconeConfig } from "./types.ts"

/**
 * Nexus credentials: the shared resolver in core/nexus-config.ts (env,
 * project-local `.nexus/`, .mcp.json, opencode.json, global CLI config).
 * `source` names where they came from, for logs; never log the token.
 */
export function getNexusConfig(directory: string): NexusConfig | null {
  return resolveNexusConfig(directory)
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

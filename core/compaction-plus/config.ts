import { resolveNexusConfig } from "../nexus-config.ts"
import type { NexusConfig } from "./types.ts"

/**
 * Nexus credentials: the shared resolver in core/nexus-config.ts (env,
 * project-local `.nexus/`, .mcp.json, opencode.json, global CLI config).
 * `source` names where they came from, for logs; never log the token.
 */
export function getNexusConfig(directory: string): NexusConfig | null {
  return resolveNexusConfig(directory)
}

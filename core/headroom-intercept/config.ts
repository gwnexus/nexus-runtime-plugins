import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { NexusConfig, ProjectContext } from "./types.ts"
import { resolveNexusConfig } from "../nexus-config.ts"

/**
 * Nexus credentials for headroom-intercept: the shared resolver in
 * core/nexus-config.ts (env, project-local, .mcp.json, opencode.json,
 * global). `source` names where they came from, for logs.
 */
export function getNexusConfig(directory: string): NexusConfig | null {
  return resolveNexusConfig(directory)
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

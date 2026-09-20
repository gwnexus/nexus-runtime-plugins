#!/usr/bin/env node
/**
 * Nexus Routing Guard — Claude Code adapter (ADR-C05, Track B2, Dispatch dc5fdf9a).
 *
 * Capability matrix: `routing_guard` = "partial" for Claude Code. There is no
 * equivalent to OpenCode's `experimental.chat.system.transform` (an
 * in-session, continuous system-prompt injection point) in Claude Code.
 * Per the dispatch's explicit instruction, this gap is disclosed, not
 * papered over with a fragile workaround: validation here only happens
 * before the session starts (`SessionStart`), not continuously mid-session.
 *
 * Mechanism: preflight validation on `SessionStart`, using
 * `detectRoutingWarnings()` from core/routing-guard/detect.ts (shared
 * verbatim with the OpenCode adapter).
 *
 * KEY DIFFERENCE FROM OPENCODE (structural, not just a hook-name swap):
 * OpenCode has `client.config.providers()` / `client.app.agents()` SDK calls
 * that return the *live, merged* provider/model catalog and agent routing
 * table directly from the running instance. Claude Code has no equivalent
 * SDK surface for this plugin to query.
 *
 * CATALOG SOURCE (confirmed live against nexus-cli v0.17.2 on 2026-09-20,
 * see Dispatch dc5fdf9a reply from nexus-app): `nexus pull`/`nexus init`
 * writes two files relative to the project's agentic root:
 *
 *   .nexus/generated/routing-catalog.json  -> { model_routes: [...] }
 *   .nexus/generated/agent-routing.json    -> { actors: [...] }
 *
 * These are read by default (paths overridable via env vars below) and
 * converted to the plugin's internal `ProviderCatalog`/`AgentInfo[]` shape
 * via `core/routing-guard/nexus-cli-catalog.ts`. See that module for the
 * `model_profile_id` <-> `route_alias` linkage assumption, which has not
 * yet been explicitly confirmed by nexus-app.
 *
 * KNOWN CAVEAT (confirmed by nexus-app, not a bug): nexus-cli only injects
 * the env vars below into `.claude/settings.json` on first-creation of that
 * file. Projects with a pre-existing `.claude/settings.json` (e.g. from
 * Track B1 testing) will not have these vars until the file is deleted and
 * regenerated via `nexus pull --force`. The default file paths below make
 * this less of an issue going forward, since the adapter finds the files
 * itself without needing the env vars at all -- the env vars are now only
 * needed to override the default location.
 *
 * If either file is missing, the check is skipped silently (fail-open,
 * matching the OpenCode adapter's never-block behavior) and logged.
 *
 * Hook configuration (.claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "hooks": [{ "type": "command", "command": "node adapters/claude-code/routing-guard/nexus-routing-guard.ts session-start" }] }
 *       ]
 *     }
 *   }
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createFileLogger } from "../../../core/logger.ts"
import { detectRoutingWarnings } from "../../../core/routing-guard/detect.ts"
import { formatBanner } from "../../../core/routing-guard/format.ts"
import {
  buildProviderCatalogFromRoutes,
  buildAgentInfoFromActors,
} from "../../../core/routing-guard/nexus-cli-catalog.ts"
import type { RoutingCatalogFile, AgentRoutingFile } from "../../../core/routing-guard/nexus-cli-catalog.ts"
import type { AgentInfo, ProviderCatalog } from "../../../core/routing-guard/types.ts"

const PLUGIN_META = { name: "nexus-routing-guard", version: "1.0.0" } as const
const ENV_ENABLED = "NEXUS_ROUTING_GUARD_ENABLED"
const ENV_CATALOG_PATH = "NEXUS_ROUTING_GUARD_CATALOG_PATH"
const ENV_AGENTS_PATH = "NEXUS_ROUTING_GUARD_AGENTS_PATH"

interface ClaudeHookInput {
  cwd?: string
}

function readJsonFile<T>(path: string | undefined): T | null {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return null
  }
}

function defaultCatalogPath(directory: string): string {
  return process.env[ENV_CATALOG_PATH] ?? join(directory, ".nexus", "generated", "routing-catalog.json")
}

function defaultAgentsPath(directory: string): string {
  return process.env[ENV_AGENTS_PATH] ?? join(directory, ".nexus", "generated", "agent-routing.json")
}

/**
 * Resolve the provider catalog + agent list from disk, accepting either:
 *  - nexus-cli's real generated shape ({ model_routes: [...] } / { actors: [...] })
 *  - the plugin's own internal shape directly ({ providers: [...] } / AgentInfo[]),
 *    for advanced/manual overrides via the env vars.
 */
function resolveCatalogAndAgents(directory: string): { catalog: ProviderCatalog; agents: AgentInfo[] } | null {
  const catalogRaw = readJsonFile<RoutingCatalogFile | ProviderCatalog>(defaultCatalogPath(directory))
  const agentsRaw = readJsonFile<AgentRoutingFile | AgentInfo[]>(defaultAgentsPath(directory))
  if (!catalogRaw || !agentsRaw) return null

  const isNexusCliCatalog = (v: unknown): v is RoutingCatalogFile =>
    !!v && typeof v === "object" && Array.isArray((v as RoutingCatalogFile).model_routes)
  const isNexusCliAgents = (v: unknown): v is AgentRoutingFile =>
    !!v && typeof v === "object" && Array.isArray((v as AgentRoutingFile).actors)

  if (isNexusCliCatalog(catalogRaw) && isNexusCliAgents(agentsRaw)) {
    return {
      catalog: buildProviderCatalogFromRoutes(catalogRaw),
      agents: buildAgentInfoFromActors(agentsRaw, catalogRaw),
    }
  }

  // Fallback: assume the files are already in the plugin's internal shape.
  return { catalog: catalogRaw as ProviderCatalog, agents: agentsRaw as AgentInfo[] }
}

/** Testable handler for the `session-start` mode. */
export function handleSessionStart(
  input: ClaudeHookInput,
  logger: (level: string, message: string) => void,
): Record<string, unknown> | null {
  if (process.env[ENV_ENABLED] === "false") {
    logger("info", `Disabled via ${ENV_ENABLED}=false`)
    return null
  }

  const directory = input.cwd ?? process.cwd()
  const resolved = resolveCatalogAndAgents(directory)

  if (!resolved) {
    logger(
      "warn",
      `Skipping check — missing catalog (${defaultCatalogPath(directory)}) or agents (${defaultAgentsPath(directory)}) file. ` +
        "Run 'nexus pull --force' to generate them (see adapter README for the first-creation-only env-var caveat).",
    )
    return null
  }

  const { catalog, agents } = resolved

  try {
    const warnings = detectRoutingWarnings(catalog, agents)

    if (warnings.length === 0) {
      logger("debug", "No routing divergence detected")
      return null
    }

    logger("warn", `${warnings.length} routing warning(s): ${warnings.map((w) => `${w.agent}:${w.code}`).join(", ")}`)

    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: formatBanner(warnings),
      },
    }
  } catch (err) {
    logger("error", `Check failed, degrading silently: ${String(err)}`)
    return null
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf-8")
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ""
  const raw = await readStdin()

  let input: ClaudeHookInput = {}
  try {
    input = JSON.parse(raw || "{}")
  } catch {
    process.exit(0)
  }

  const directory = input.cwd ?? process.cwd()
  const fileLog = createFileLogger(directory, "routing-guard.log")
  const logger = (level: string, message: string) => fileLog(level, message)

  fileLog("info", "=== Plugin invoked ===")

  if (mode === "session-start") {
    const output = handleSessionStart(input, logger)
    if (output) process.stdout.write(JSON.stringify(output))
    process.exit(0)
  }

  fileLog("warn", `Unknown mode "${mode}" (expected session-start) — no-op`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}\n`)
    process.exit(0)
  })
}

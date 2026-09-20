import { type Plugin, tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { StructuredLogger } from "../../../core/headroom-intercept/structured-logger.ts"
import { OriginalStore } from "../../../core/headroom-intercept/store.ts"
import { getNexusConfig, readProjectIdFromAgentsMd, fetchProjectContext } from "../../../core/headroom-intercept/config.ts"
import { initialMetrics } from "../../../core/headroom-intercept/types.ts"
import type { PluginMode, SessionMetrics } from "../../../core/headroom-intercept/types.ts"
import { POLICIES } from "../../../core/headroom-intercept/policies.ts"
import { wrapRetrievedContent } from "../../../core/headroom-intercept/compression.ts"
import {
  intercept,
  commitTransformed,
  commitTransformFailed,
} from "../../../core/headroom-intercept/engine.ts"

/**
 * Nexus Headroom Intercept — OpenCode adapter (ADR-C05, Track B2).
 *
 * Wires the runtime-agnostic core/headroom-intercept engine to OpenCode's
 * `tool.execute.after` hook and the plugin-owned `nexus_headroom_intercept_retrieve`
 * tool. Everything policy/compression/cache/config related lives in
 * core/headroom-intercept/*; this file only handles OpenCode-specific
 * concerns: SDK version gating, output-shape normalization
 * (`output.output` string vs. MCP `content[]`), tool registration, and the
 * `session.idle` summary event.
 */
const PLUGIN_META = {
  name: "nexus-headroom-intercept",
  version: "0.5.14",
} as const

const REQUIRED_SDK_MAJOR = 1
const REQUIRED_SDK_MINOR = 14

type PluginModeEnv = PluginMode
const DEFAULT_MODE: PluginModeEnv = "observe"
const REQUIRE_PREFLIGHT = process.env.HEADROOM_REQUIRE_PREFLIGHT === "true"
const DEBUG = process.env.HEADROOM_DEBUG === "true"

function parseBoundedPositiveInt(raw: string | undefined, fallback: number, absoluteMax: number): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, absoluteMax)
}

const RETRIEVAL_MAX_LINES_HARD = parseBoundedPositiveInt(process.env.HEADROOM_RETRIEVAL_MAX_LINES, 200, 1000)
const RETRIEVAL_MAX_CHARS_HARD = parseBoundedPositiveInt(process.env.HEADROOM_RETRIEVAL_MAX_CHARS, 24_000, 100_000)

interface ToolOutput {
  title?: string
  output?: string
  metadata?: unknown
  content?: Array<{ text?: string; type?: string; [key: string]: unknown }>
  attachments?: unknown
  isError?: boolean
}

interface NormalizedToolResult {
  text: string
  apply: (replacement: string) => void
  supported: boolean
  sourceShape: "normalized-output" | "mcp-content" | "unknown"
}

function normalizeToolResult(output: unknown): NormalizedToolResult {
  if (
    output &&
    typeof output === "object" &&
    typeof (output as any).output === "string" &&
    (output as any).output.length > 0
  ) {
    return {
      text: (output as any).output,
      apply(replacement: string) {
        ;(output as any).output = replacement
      },
      supported: true,
      sourceShape: "normalized-output",
    }
  }

  if (output && typeof output === "object" && Array.isArray((output as any).content)) {
    const result = output as any
    const textParts: any[] = result.content.filter((part: any) => part?.type === "text" && typeof part.text === "string")
    const nonTextParts: any[] = result.content.filter(
      (part: any) => !(part?.type === "text" && typeof part.text === "string"),
    )

    return {
      text: textParts.map((p: any) => p.text).join("\n"),
      apply(replacement: string) {
        result.content = [{ type: "text", text: replacement }, ...nonTextParts]
      },
      supported: textParts.length > 0,
      sourceShape: "mcp-content",
    }
  }

  return { text: "", apply() {}, supported: false, sourceShape: "unknown" }
}

function checkSdkVersion(ctx: any, logger: StructuredLogger): boolean {
  try {
    const installedPkgPath = join(ctx.directory, ".opencode", "node_modules", "@opencode-ai", "plugin", "package.json")
    const declaredPkgPath = join(ctx.directory, ".opencode", "package.json")

    let sdkVersion = ""
    let source = "unknown"

    if (existsSync(installedPkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8"))
        if (typeof pkg.version === "string") {
          sdkVersion = pkg.version
          source = "installed"
        }
      } catch {}
    }

    if (!sdkVersion && existsSync(declaredPkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(declaredPkgPath, "utf-8"))
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        const declared: string = deps["@opencode-ai/plugin"] ?? ""
        if (declared) {
          sdkVersion = declared.replace(/^[\^~>=<\s]+/, "").split(/\s/)[0]
          source = "declared-range"
        }
      } catch {}
    }

    if (!sdkVersion) {
      logger.log("warn", "sdk_version_unknown", { reason: "neither installed nor declared SDK version found", fallback: "observe" })
      return false
    }

    const match = sdkVersion.match(/^(\d+)\.(\d+)/)
    if (!match) {
      logger.log("warn", "sdk_version_parse_failed", { sdkVersion, source, fallback: "observe" })
      return false
    }

    const major = parseInt(match[1], 10)
    const minor = parseInt(match[2], 10)
    const compatible = major === REQUIRED_SDK_MAJOR && minor >= REQUIRED_SDK_MINOR

    if (!compatible) {
      logger.log("warn", "sdk_version_incompatible", {
        sdkVersion,
        source,
        required: `>=${REQUIRED_SDK_MAJOR}.${REQUIRED_SDK_MINOR}`,
        fallback: "observe",
      })
    } else {
      logger.log("info", "sdk_version_ok", { sdkVersion, source })
    }
    return compatible
  } catch {
    logger.log("warn", "sdk_version_check_error", { fallback: "observe" })
    return false
  }
}

export const NexusHeadroomIntercept: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const logger = new StructuredLogger(directory, PLUGIN_META.name, PLUGIN_META.version, DEBUG)

  let mode: PluginModeEnv = (process.env.HEADROOM_MODE as PluginModeEnv) ?? DEFAULT_MODE
  const requestedMode = mode
  let downgradeReason: string | null = null

  function warnLoudDowngrade(reason: string, detail: string): void {
    downgradeReason = reason
    if (requestedMode !== "transform") return
    // eslint-disable-next-line no-console
    console.error(
      `[nexus-headroom-intercept] WARNING: HEADROOM_MODE=transform was requested but is ` +
        `running in 'observe' mode (no compression applied). Reason: ${reason} — ${detail}. ` +
        `See .nexus/headroom-intercept.jsonl for details, or re-run 'nexus preflight'.`,
    )
  }

  if (mode === "transform") {
    const sdkOk = checkSdkVersion(ctx, logger)
    if (!sdkOk) {
      mode = "observe"
      logger.log("warn", "mode_downgraded", { reason: "sdk_version_incompatible_or_unknown", mode })
      warnLoudDowngrade("sdk_version_incompatible_or_unknown", "installed @opencode-ai/plugin SDK version is below the required minimum")
    }
  }

  const projectId = readProjectIdFromAgentsMd(directory)

  if (projectId) {
    const nexusConfig = getNexusConfig(directory)
    if (nexusConfig) {
      const projectContext = await fetchProjectContext(nexusConfig, projectId)
      if (projectContext && !projectContext.headroomEnabled) {
        mode = "observe"
        logger.log("warn", "project_gate_headroom_disabled", { projectId, mode })
        warnLoudDowngrade("project_gate_headroom_disabled", "the 'headroom' plugin is not enabled for this project on the Nexus platform")
      } else if (projectContext) {
        logger.log("info", "project_gate_ok", { projectId, credentialSource: nexusConfig.source })
      } else {
        if (REQUIRE_PREFLIGHT && mode === "transform") {
          mode = "observe"
          logger.log("warn", "project_gate_preflight_unreachable_strict", {
            projectId,
            mode,
            require_preflight: true,
            credentialSource: nexusConfig.source,
          })
          warnLoudDowngrade(
            "project_gate_preflight_unreachable_strict",
            `preflight call to the Nexus API failed (credential source: ${nexusConfig.source ?? "unknown"}) — ` +
              `likely a stale/invalid token; run 'nexus status' / 'nexus login' to verify`,
          )
        } else {
          logger.log("warn", "project_gate_preflight_unreachable", { projectId, mode })
        }
      }
    } else {
      if (REQUIRE_PREFLIGHT && mode === "transform") {
        mode = "observe"
        logger.log("warn", "project_gate_no_credentials_strict", { mode, require_preflight: true })
        warnLoudDowngrade("project_gate_no_credentials_strict", "no Nexus API credentials found (env, opencode.json, or ~/.config/nexus/); run 'nexus login'")
      } else {
        logger.log("warn", "project_gate_no_credentials", { mode })
      }
    }
  } else {
    if (mode === "transform") {
      mode = "observe"
      logger.log("warn", "project_gate_no_project_id_transform_downgrade", {
        mode,
        reason: "unknown namespace — transform requires explicit project identity",
      })
      warnLoudDowngrade("project_gate_no_project_id_transform_downgrade", "no project_id found in .nexus/AGENTS.md — run 'nexus link' or 'nexus init'")
    } else {
      logger.log("warn", "project_gate_no_project_id", { mode })
    }
  }

  const store = new OriginalStore(directory, projectId)
  try {
    store.evictDisk()
  } catch {}

  const metrics: SessionMetrics = initialMetrics()

  store.onIntegrityFailure = (hash: string) => {
    metrics.totalCacheIntegrityFailures++
    logger.log("warn", "cache_integrity_failed", { hash })
  }
  store.onCacheReadFailed = (hash: string, reason: string) => {
    metrics.totalCacheReadFailures++
    logger.log("warn", "cache_read_failed", { hash, reason })
  }

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: `v${PLUGIN_META.version} loaded — mode=${mode}, project=${projectId ?? "unknown"}, policies=${Object.keys(POLICIES).length}`,
    },
  })
  logger.log("info", "plugin_loaded", {
    mode,
    version: PLUGIN_META.version,
    project: projectId ?? "unknown",
    policies: Object.keys(POLICIES).length,
  })

  return {
    tool: {
      nexus_headroom_intercept_retrieve: tool({
        description:
          "Retrieve the original uncompressed content stored by the nexus-headroom-intercept plugin. " +
          "Use this when you need the full content behind a [HEADROOM:v1] compressed result. " +
          "Pass the hash from the compressed output.",
        args: {
          hash: tool.schema.string().describe("The SHA-256 content hash from the [HEADROOM:v1] header."),
          query: tool.schema.string().optional().describe("Optional: a search query to return only relevant lines from the original."),
        },
        async execute({ hash, query }) {
          if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
            return JSON.stringify({
              found: false,
              hash: hash ?? "",
              error: "invalid_hash",
              message: "Hash must be a 64-character lowercase hexadecimal string (full SHA-256).",
            })
          }

          const content = store.get(hash)
          logger.debug("retrieve_lookup", {
            hash,
            found: content !== null,
            query_present: query != null && query.trim().length > 0,
            query_length: query ? query.length : 0,
          })
          if (!content) {
            return JSON.stringify({
              found: false,
              hash,
              message:
                "Content not found in plugin cache. It may have expired (TTL: 24h) or " +
                "this hash was generated in a previous session. Re-fetch using the original tool.",
            })
          }

          const effectiveMaxLines = RETRIEVAL_MAX_LINES_HARD
          const effectiveMaxChars = RETRIEVAL_MAX_CHARS_HARD

          if (query && query.trim()) {
            const qLower = query.toLowerCase()
            const lines = content.split("\n")
            const matched = lines.filter((l) => l.toLowerCase().includes(qLower))

            if (matched.length === 0) {
              return JSON.stringify({
                found: true,
                hash,
                query,
                matched_lines: 0,
                returned_lines: 0,
                returned_chars: 0,
                content: null,
                message: "No lines matched the query. Refine the query or omit it to retrieve a bounded excerpt.",
              })
            }

            const bounded = matched.slice(0, effectiveMaxLines).join("\n").slice(0, effectiveMaxChars)
            return JSON.stringify({
              found: true,
              hash,
              query,
              matched_lines: matched.length,
              returned_lines: Math.min(matched.length, effectiveMaxLines),
              returned_chars: bounded.length,
              truncated: matched.length > effectiveMaxLines || bounded.length < matched.slice(0, effectiveMaxLines).join("\n").length,
              content: wrapRetrievedContent(bounded),
            })
          }

          const lines = content.split("\n")
          const sliced = lines.slice(0, effectiveMaxLines).join("\n")
          const excerpt = sliced.slice(0, effectiveMaxChars)
          const truncated = lines.length > effectiveMaxLines || excerpt.length < sliced.length
          const hint = truncated
            ? `Showing first ${effectiveMaxLines} lines / ${effectiveMaxChars} chars. Use a query param to filter for specific content.`
            : undefined
          return JSON.stringify({
            found: true,
            hash,
            returned_lines: excerpt.split("\n").length,
            returned_chars: excerpt.length,
            total_lines: lines.length,
            total_chars: content.length,
            truncated,
            content: wrapRetrievedContent(excerpt),
            message: hint,
          })
        },
      }),
    },

    "tool.execute.after": async (input, output) => {
      const toolName = String(input?.tool ?? "")
      if (!toolName) return

      const rawOut = output as unknown as ToolOutput
      const normalized = normalizeToolResult(output)

      logger.debug("normalized", {
        tool: toolName,
        sourceShape: normalized.sourceShape,
        supported: normalized.supported,
        textLength: normalized.text?.length ?? 0,
        contentParts: Array.isArray((output as any)?.content) ? (output as any).content.length : undefined,
      })

      const result = intercept(
        {
          toolName,
          text: normalized.text || null,
          supported: normalized.supported,
          sourceShape: normalized.sourceShape,
          isError: rawOut.isError === true,
          mode,
        },
        metrics,
        store,
        logger,
      )

      if (result.action === "transform_candidate" && result.compact && result.event) {
        try {
          normalized.apply(result.compact)
          commitTransformed(result.event, metrics, logger)
        } catch (err) {
          commitTransformFailed(result.event, metrics, logger, err)
        }
      }
    },

    event: async ({ event }) => {
      const ev = event as any
      const isIdle = ev.type === "session.idle" || ev.name === "session.idle" || ev.kind === "session.idle"

      const hasActivity =
        metrics.events.length > 0 ||
        metrics.totalCacheIntegrityFailures > 0 ||
        metrics.totalFullRetrievalDenied > 0 ||
        metrics.totalOutputBudgetTruncated > 0 ||
        metrics.totalUnsupportedShapes > 0 ||
        metrics.totalCacheReadFailures > 0

      if (isIdle && hasActivity) {
        logger.log("info", "session_summary", {
          mode,
          requestedMode,
          downgradeReason,
          compressions: metrics.totalCompressions,
          locallyAppliedTransforms: metrics.locallyAppliedTransforms,
          observations: metrics.totalObservations,
          skips: metrics.totalSkips,
          passthroughs: metrics.totalPassthroughs,
          noGain: metrics.totalNoGain,
          unsupportedShapes: metrics.totalUnsupportedShapes,
          potentialSavedTokens: metrics.potentialSavedTokens,
          cacheIntegrityFailures: metrics.totalCacheIntegrityFailures,
          fullRetrievalDenied: metrics.totalFullRetrievalDenied,
          outputBudgetTruncated: metrics.totalOutputBudgetTruncated,
          cacheReadFailures: metrics.totalCacheReadFailures,
        })
      }
    },
  }
}

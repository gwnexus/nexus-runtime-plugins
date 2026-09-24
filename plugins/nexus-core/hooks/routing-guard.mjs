#!/usr/bin/env node
// GENERATED FILE -- do not edit directly. Built from adapters/claude-code/routing-guard/nexus-routing-guard.ts by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.

// adapters/claude-code/routing-guard/nexus-routing-guard.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

// core/logger.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
function createFileLogger(directory, logFileName) {
  let logDir = null;
  return (level, message) => {
    try {
      if (!logDir) {
        logDir = join(directory, ".nexus");
        mkdirSync(logDir, { recursive: true });
      }
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}
`;
      appendFileSync(join(logDir, logFileName), line);
    } catch {
    }
  };
}

// core/routing-guard/detect.ts
function detectRoutingWarnings(catalog, agents) {
  const byId = new Map(catalog.providers.map((p) => [p.id, p]));
  const warnings = [];
  for (const agent of agents) {
    if (!agent.model) continue;
    const { providerID, modelID } = agent.model;
    const provider = byId.get(providerID);
    if (!provider) {
      warnings.push({
        code: "unknown_provider",
        agent: agent.name,
        provider: providerID,
        model: modelID,
        message: `Agent "${agent.name}" is routed to provider "${providerID}", which this runtime instance does not have configured.`
      });
      continue;
    }
    if (!(modelID in provider.models)) {
      warnings.push({
        code: "unknown_model",
        agent: agent.name,
        provider: providerID,
        model: modelID,
        message: `Agent "${agent.name}" is routed to "${providerID}/${modelID}", but provider "${providerID}" does not serve a model with that id.`
      });
    }
  }
  return warnings;
}

// core/routing-guard/format.ts
function formatBanner(warnings) {
  const lines = warnings.map((w) => `  - [${w.code}] ${w.message}`);
  return "<system-reminder>\n[nexus-routing-guard] Model routing divergence detected between the Nexus-configured agents and what this runtime instance can actually serve. Report this to the user verbatim before proceeding:\n" + lines.join("\n") + "\nRemediation: check the affected agent's model in opencode.json (or the equivalent Claude Code project config) against the provider catalog (`nexus pull` may need a re-run if this was fixed on the Nexus side), or ensure the provider is configured in this runtime instance.\n</system-reminder>";
}

// core/routing-guard/nexus-cli-catalog.ts
function buildProviderCatalogFromRoutes(file) {
  const byProvider = /* @__PURE__ */ new Map();
  for (const route of file.model_routes ?? []) {
    if (!route.provider || !route.model) continue;
    if (!byProvider.has(route.provider)) byProvider.set(route.provider, {});
    byProvider.get(route.provider)[route.model] = {};
  }
  return {
    providers: Array.from(byProvider.entries()).map(([id, models]) => ({ id, models }))
  };
}
function buildAgentInfoFromActors(agentFile, catalogFile) {
  const routeByAlias = new Map(
    (catalogFile.model_routes ?? []).filter((r) => r.route_alias).map((r) => [r.route_alias, r])
  );
  return (agentFile.actors ?? []).map((actor) => {
    const route = actor.model_profile_id ? routeByAlias.get(actor.model_profile_id) : void 0;
    return {
      name: actor.slug,
      ...route ? { model: { providerID: route.provider, modelID: route.model } } : {}
    };
  });
}

// adapters/claude-code/routing-guard/nexus-routing-guard.ts
var PLUGIN_META = { name: "nexus-routing-guard", version: "1.0.0" };
var ENV_ENABLED = "NEXUS_ROUTING_GUARD_ENABLED";
var ENV_CATALOG_PATH = "NEXUS_ROUTING_GUARD_CATALOG_PATH";
var ENV_AGENTS_PATH = "NEXUS_ROUTING_GUARD_AGENTS_PATH";
function readJsonFile(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
function defaultCatalogPath(directory) {
  return process.env[ENV_CATALOG_PATH] ?? join2(directory, ".nexus", "generated", "routing-catalog.json");
}
function defaultAgentsPath(directory) {
  return process.env[ENV_AGENTS_PATH] ?? join2(directory, ".nexus", "generated", "agent-routing.json");
}
function resolveCatalogAndAgents(directory) {
  const catalogRaw = readJsonFile(defaultCatalogPath(directory));
  const agentsRaw = readJsonFile(defaultAgentsPath(directory));
  if (!catalogRaw || !agentsRaw) return null;
  const isNexusCliCatalog = (v) => !!v && typeof v === "object" && Array.isArray(v.model_routes);
  const isNexusCliAgents = (v) => !!v && typeof v === "object" && Array.isArray(v.actors);
  if (isNexusCliCatalog(catalogRaw) && isNexusCliAgents(agentsRaw)) {
    return {
      catalog: buildProviderCatalogFromRoutes(catalogRaw),
      agents: buildAgentInfoFromActors(agentsRaw, catalogRaw)
    };
  }
  return { catalog: catalogRaw, agents: agentsRaw };
}
function handleSessionStart(input, logger) {
  if (process.env[ENV_ENABLED] === "false") {
    logger("info", `Disabled via ${ENV_ENABLED}=false`);
    return null;
  }
  const directory = input.cwd ?? process.cwd();
  const resolved = resolveCatalogAndAgents(directory);
  if (!resolved) {
    logger(
      "warn",
      `Skipping check \u2014 missing catalog (${defaultCatalogPath(directory)}) or agents (${defaultAgentsPath(directory)}) file. Run 'nexus pull --force' to generate them (see adapter README for the first-creation-only env-var caveat).`
    );
    return null;
  }
  const { catalog, agents } = resolved;
  try {
    const warnings = detectRoutingWarnings(catalog, agents);
    if (warnings.length === 0) {
      logger("debug", "No routing divergence detected");
      return null;
    }
    logger("warn", `${warnings.length} routing warning(s): ${warnings.map((w) => `${w.agent}:${w.code}`).join(", ")}`);
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: formatBanner(warnings)
      }
    };
  } catch (err) {
    logger("error", `Check failed, degrading silently: ${String(err)}`);
    return null;
  }
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
async function main() {
  const mode = process.argv[2] ?? "";
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const directory = input.cwd ?? process.cwd();
  const fileLog = createFileLogger(directory, "routing-guard.log");
  const logger = (level, message) => fileLog(level, message);
  fileLog("info", "=== Plugin invoked ===");
  if (mode === "session-start") {
    const output = handleSessionStart(input, logger);
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }
  fileLog("warn", `Unknown mode "${mode}" (expected session-start) \u2014 no-op`);
  process.exit(0);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}
`);
    process.exit(0);
  });
}
export {
  handleSessionStart
};

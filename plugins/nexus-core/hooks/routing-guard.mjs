#!/usr/bin/env node
// GENERATED FILE -- do not edit directly. Built from adapters/claude-code/routing-guard/nexus-routing-guard.ts by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.

// adapters/claude-code/routing-guard/nexus-routing-guard.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

// core/logger.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
var DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
var CHECK_EVERY_WRITES = 200;
function createFileLogger(directory, logFileName, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  let logDir = null;
  let writes = 0;
  return (level, message) => {
    try {
      if (!logDir) {
        logDir = join(directory, ".nexus");
        mkdirSync(logDir, { recursive: true });
      }
      const path = join(logDir, logFileName);
      if (writes++ % CHECK_EVERY_WRITES === 0) rotateIfNeeded(path, maxBytes);
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}
`;
      appendFileSync(path, line);
    } catch {
    }
  };
}
function rotateIfNeeded(path, maxBytes) {
  try {
    if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`);
  } catch {
  }
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
var LANE_CODES = /* @__PURE__ */ new Set([
  "session_model_not_allowed",
  "gateway_actor_in_session",
  "unresolved_actor_model"
]);
function formatBanner(warnings) {
  const lines = warnings.map((w) => `  - [${w.code}] ${w.message}`);
  const laneHint = warnings.some((w) => LANE_CODES.has(w.code)) ? "Lane warnings: fix the actor's model profile or lane on the Nexus side and re-run `nexus pull`; gateway-lane actors run only in a gateway-backed process, never as subagents of this session.\n" : "";
  return "<system-reminder>\n[nexus-routing-guard] Model routing divergence detected between the Nexus-configured agents and what this runtime instance can actually serve. Report this to the user verbatim before proceeding:\n" + lines.join("\n") + "\nRemediation: check the affected agent's model in opencode.json (or the equivalent Claude Code project config) against the provider catalog (`nexus pull` may need a re-run if this was fixed on the Nexus side), or ensure the provider is configured in this runtime instance.\n" + laneHint + "</system-reminder>";
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
function actorRouteKey(actor) {
  return actor.profile_slug || actor.route_alias || actor.model_profile_id || void 0;
}
function buildAgentInfoFromActors(agentFile, catalogFile) {
  const routeByAlias = new Map(
    (catalogFile.model_routes ?? []).filter((r) => r.route_alias).map((r) => [r.route_alias, r])
  );
  return (agentFile.actors ?? []).map((actor) => {
    const key = actorRouteKey(actor);
    const route = key ? routeByAlias.get(key) : void 0;
    return {
      name: actor.slug,
      ...route ? { model: { providerID: route.provider, modelID: route.model } } : {}
    };
  });
}

// core/routing-guard/lanes.ts
var SESSION_MODEL_RE = /^(inherit|sonnet|opus|haiku|claude-[a-z0-9][a-z0-9.\-]*)$/;
function isAllowedSessionModel(model) {
  return SESSION_MODEL_RE.test(model.trim());
}
function parseSubagentFrontmatter(markdown) {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields = /* @__PURE__ */ new Map();
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fields.set(kv[1], kv[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  const name = fields.get("name");
  if (!name || !fields.get("description")) return null;
  const model = fields.get("model");
  return model ? { name, model } : { name };
}
function actorLane(actor) {
  return actor.lane === "session" || actor.lane === "gateway" ? actor.lane : null;
}
function detectLaneWarnings(actors, subagents) {
  const subagentByName = new Map(subagents.map((s) => [s.name, s]));
  const warnings = [];
  for (const actor of actors) {
    const lane = actorLane(actor);
    if (!lane) continue;
    const subagent = subagentByName.get(actor.slug);
    if (actor.status && actor.status !== "resolved") {
      warnings.push({
        code: "unresolved_actor_model",
        agent: actor.slug,
        provider: lane,
        model: actor.profile_slug ?? actor.route_alias ?? "",
        message: `Agent "${actor.slug}" has no resolved model on the Nexus side (status "${actor.status}"); it runs on the session default.`
      });
    }
    if (lane === "gateway") {
      if (subagent) {
        warnings.push({
          code: "gateway_actor_in_session",
          agent: actor.slug,
          provider: lane,
          model: subagent.model ?? "",
          message: `Agent "${actor.slug}" belongs to the gateway lane but is defined as a Claude Code subagent (.claude/agents); it would run inside the subscription session instead of a gateway-backed process.`
        });
      }
      continue;
    }
    const model = subagent?.model ?? actor.session_model;
    if (model && !isAllowedSessionModel(model)) {
      warnings.push({
        code: "session_model_not_allowed",
        agent: actor.slug,
        provider: lane,
        model,
        message: `Agent "${actor.slug}" runs in the Claude session but names model "${model}"; only inherit, sonnet, opus, haiku or claude-* are allowed there.`
      });
    }
  }
  return warnings;
}
function summarizeLanes(actors) {
  const byLane = { session: [], gateway: [] };
  for (const actor of actors) {
    const lane = actorLane(actor);
    if (lane) byLane[lane].push(actor.slug);
  }
  if (byLane.session.length === 0 && byLane.gateway.length === 0) return null;
  return `session=[${byLane.session.join(", ")}] gateway=[${byLane.gateway.join(", ")}]`;
}

// core/project-root.ts
import { statSync as statSync2 } from "node:fs";
import { dirname, resolve } from "node:path";
function resolveProjectRoot(cwd, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR?.trim();
  if (projectDir) return resolve(projectDir);
  return findGitTopLevel(cwd ?? process.cwd());
}
function findGitTopLevel(start) {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    if (hasGitEntry(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
function hasGitEntry(dir) {
  try {
    const st = statSync2(resolve(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

// core/entrypoint.ts
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
function isEntrypoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

// adapters/claude-code/routing-guard/nexus-routing-guard.ts
var PLUGIN_META = { name: "nexus-routing-guard", version: "1.1.0" };
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
      agents: buildAgentInfoFromActors(agentsRaw, catalogRaw),
      actors: agentsRaw.actors
    };
  }
  return { catalog: catalogRaw, agents: agentsRaw, actors: [] };
}
function readClaudeSubagents(directory) {
  const dir = join2(directory, ".claude", "agents");
  if (!existsSync(dir)) return [];
  const subagents = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const parsed = parseSubagentFrontmatter(readFileSync(join2(dir, file), "utf-8"));
        if (parsed) subagents.push(parsed);
      } catch {
      }
    }
  } catch {
    return [];
  }
  return subagents;
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
  const { catalog, agents, actors } = resolved;
  try {
    const lanes = summarizeLanes(actors);
    if (lanes) logger("info", `Actor lanes: ${lanes}`);
    const laneWarnings = lanes ? detectLaneWarnings(actors, readClaudeSubagents(directory)) : [];
    const warnings = [...detectRoutingWarnings(catalog, agents), ...laneWarnings];
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
  const directory = resolveProjectRoot(input.cwd);
  if (!directory) process.exit(0);
  input = { ...input, cwd: directory };
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
if (isEntrypoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_META.name}] error: ${err}
`);
    process.exit(0);
  });
}
export {
  handleSessionStart
};

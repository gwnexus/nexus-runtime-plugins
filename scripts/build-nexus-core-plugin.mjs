#!/usr/bin/env node
/**
 * Builds the `nexus-core` Claude Code plugin's hook bundles (ADR-0117,
 * nexus-app, Dispatch 0e38cf7b Part 2).
 *
 * Plugins install via git, and TypeScript source is not directly executable
 * by Claude Code's `command`-type hooks, so each of the five Claude Code
 * adapters is bundled here into a single-file ESM `.mjs` script under
 * `plugins/nexus-core/hooks/`. These bundles are committed to the repo (not
 * gitignored) so a git-sourced marketplace install works with no build step
 * on the user's machine. Run this script whenever an adapter's source or its
 * shared `core/*` modules change, and commit the regenerated output in the
 * same change -- CI's `verify` mode fails the build if the committed
 * bundles have drifted from source (see `.github/workflows/ci.yml`).
 *
 * Usage:
 *   node scripts/build-nexus-core-plugin.mjs          # build (writes files)
 *   node scripts/build-nexus-core-plugin.mjs --verify # build in-memory, diff
 *                                                      # against committed
 *                                                      # bundles, exit 1 on
 *                                                      # drift
 */
import { build } from "esbuild"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..")
const OUT_DIR = join(REPO_ROOT, "plugins/nexus-core/hooks")

/** name -> source entrypoint, relative to repo root. */
const ADAPTERS = {
  "session-guard": "adapters/claude-code/session-guard/nexus-session-guard.ts",
  "headroom-intercept": "adapters/claude-code/headroom-intercept/nexus-headroom-intercept.ts",
  "compaction-plus": "adapters/claude-code/compaction-plus/nexus-compaction-plus.ts",
  "routing-guard": "adapters/claude-code/routing-guard/nexus-routing-guard.ts",
  "cost-control": "adapters/claude-code/cost-control/nexus-cost-control.ts",
}

const verify = process.argv.includes("--verify")

async function bundle(name, entry) {
  const result = await build({
    entryPoints: [join(REPO_ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    legalComments: "none",
    banner: {
      js: `// GENERATED FILE -- do not edit directly. Built from ${entry} by scripts/build-nexus-core-plugin.mjs. Re-run that script after changing the source.`,
    },
  })
  const output = result.outputFiles[0].text
  return output
}

async function main() {
  let drifted = false

  for (const [name, entry] of Object.entries(ADAPTERS)) {
    const output = await bundle(name, entry)
    const outPath = join(OUT_DIR, `${name}.mjs`)

    if (verify) {
      const existing = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null
      if (existing !== output) {
        console.error(`[drift] ${outPath} does not match rebuilt output from ${entry}`)
        drifted = true
      } else {
        console.log(`[ok] ${outPath}`)
      }
      continue
    }

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, output)
    console.log(`[built] ${outPath}`)
  }

  if (verify && drifted) {
    console.error(
      "\nOne or more committed nexus-core hook bundles are out of date. Run `node scripts/build-nexus-core-plugin.mjs` and commit the result.",
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

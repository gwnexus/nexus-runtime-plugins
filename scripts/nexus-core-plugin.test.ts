import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Layout guard for the nexus-core Claude Code plugin: hooks and agents only.
// Workflow skills belong to the project's own skills, and project skills run
// these agents by name, so the agent names are part of the plugin's contract.

const PLUGIN_DIR = join(import.meta.dirname, "..", "plugins", "nexus-core")
const EXPECTED_AGENTS = ["architect", "documentation-reviewer", "reviewer", "security-reviewer"]

function frontmatterName(file: string): string | undefined {
  const match = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)
  return match?.[1].match(/^name:\s*(\S+)\s*$/m)?.[1]
}

describe("nexus-core plugin layout", () => {
  it("ships no skills directory", () => {
    expect(existsSync(join(PLUGIN_DIR, "skills"))).toBe(false)
  })

  it("does not declare skills in plugin.json", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"))
    expect(manifest.skills).toBeUndefined()
    expect(manifest.commands).toBeUndefined()
  })

  it("ships exactly the expected agents", () => {
    const files = readdirSync(join(PLUGIN_DIR, "agents")).filter((f) => f.endsWith(".md")).sort()
    expect(files).toEqual(EXPECTED_AGENTS.map((a) => `${a}.md`))
  })

  it.each(EXPECTED_AGENTS)("agent %s keeps its name in frontmatter", (agent) => {
    expect(frontmatterName(join(PLUGIN_DIR, "agents", `${agent}.md`))).toBe(agent)
  })

  it("agents do not reference removed skills", () => {
    for (const agent of EXPECTED_AGENTS) {
      const body = readFileSync(join(PLUGIN_DIR, "agents", `${agent}.md`), "utf8")
      expect(body, agent).not.toMatch(/\bskill\b/i)
    }
  })

  it("keeps the hooks wiring", () => {
    expect(existsSync(join(PLUGIN_DIR, "hooks", "hooks.json"))).toBe(true)
  })

  it("runs the session-guard SessionStart hook for every session source, forks included", () => {
    const hooks = JSON.parse(readFileSync(join(PLUGIN_DIR, "hooks", "hooks.json"), "utf8")).hooks
    const entry = hooks.SessionStart.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes("session-guard.mjs session-start")),
    )
    expect(entry?.matcher?.split("|").sort()).toEqual(["clear", "fork", "resume", "startup"])
  })
})

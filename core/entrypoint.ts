import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * True when the module with `moduleUrl` (pass `import.meta.url`) is the
 * script Node was started with, i.e. a hook run rather than a test import.
 *
 * `import.meta.url` is percent-encoded and symlink-resolved, `process.argv[1]`
 * is a raw path. Comparing them as `file://${argv[1]}` fails for paths with a
 * space or another encoded character, Windows paths, and hooks reached
 * through a symlink, and the hook then exits 0 without doing anything.
 */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

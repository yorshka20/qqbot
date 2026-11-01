import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * Repo root = the nearest ancestor dir whose package.json has "workspaces".
 * Resolved from THIS file's location (import.meta.url), not process.cwd() —
 * so any code path that needs to read runtime assets (config, prompts, logs,
 * data/, etc.) works regardless of how or where the bot was launched.
 */
export function getRepoRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(json.workspaces)) {
          cached = dir;
          return dir;
        }
      } catch {
        // Malformed package.json — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('[repoRoot] could not locate workspaces root from ' + fileURLToPath(import.meta.url));
}

/** Convenience: resolve a path relative to repo root. */
export function fromRepoRoot(...segments: string[]): string {
  return join(getRepoRoot(), ...segments);
}

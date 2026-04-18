/**
 * Path safety utilities for static server and file manager.
 * Ensures resolved paths stay within a base directory (no .. traversal).
 */

import { relative, resolve } from 'path';

/**
 * Resolve a path relative to baseDir.
 * Returns null if the result would be outside baseDir (path traversal).
 */
export function resolveSafe(baseDir: string, relativePath: string): string | null {
  const base = resolve(baseDir);
  const resolved = resolve(base, relativePath);
  const rel = relative(base, resolved);
  if (rel.startsWith('..')) {
    return null;
  }
  return resolved;
}

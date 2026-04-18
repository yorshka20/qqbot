/**
 * Config loading utilities — supports both single-file (config.jsonc) and
 * split-directory (config.d/) layouts.
 *
 * Shared by Config class, scripts, and tests.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

/**
 * Read all `.jsonc` files in `dirPath`, parse each, and shallow-merge
 * their top-level keys into a single object (alphabetical file order).
 */
export function loadConfigDir(dirPath: string): Record<string, unknown> {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    throw new Error(`Config directory not found: ${dirPath}`);
  }

  const files = readdirSync(dirPath)
    .filter((f) => extname(f).toLowerCase() === '.jsonc')
    .sort();

  if (files.length === 0) {
    throw new Error(`Config directory ${dirPath} contains no .jsonc files`);
  }

  let merged: Record<string, unknown> = {};
  for (const file of files) {
    const content = readFileSync(join(dirPath, file), 'utf-8');
    const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
    const parsed = parseJsonc(content, parseErrors);

    if (parseErrors.length > 0) {
      const msgs = parseErrors.map((e) => `Error ${e.error} at offset ${e.offset}`);
      throw new Error(`JSONC parse errors in ${join(dirPath, file)}: ${msgs.join(', ')}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Config file ${join(dirPath, file)} must contain a valid JSON object`);
    }

    merged = { ...merged, ...(parsed as Record<string, unknown>) };
  }

  return merged;
}

/**
 * Parse a single `.jsonc` file and return the result.
 */
export function loadConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
  const parsed = parseJsonc(content, parseErrors);

  if (parseErrors.length > 0) {
    const msgs = parseErrors.map((e) => `Error ${e.error} at offset ${e.offset}`);
    throw new Error(`JSONC parse errors in ${filePath}: ${msgs.join(', ')}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${filePath} must contain a valid JSON object`);
  }

  return parsed as Record<string, unknown>;
}

/**
 * Auto-detect config source: if `pathOrDir` is a directory, load all .jsonc
 * files from it; if it's a file, load that single file.
 */
export function loadConfigAuto(pathOrDir: string): Record<string, unknown> {
  if (!existsSync(pathOrDir)) {
    throw new Error(`Config path not found: ${pathOrDir}`);
  }

  if (statSync(pathOrDir).isDirectory()) {
    return loadConfigDir(pathOrDir);
  }

  return loadConfigFile(pathOrDir);
}

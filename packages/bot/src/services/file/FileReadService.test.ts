// Tests for FileReadService path guards, focused on the secret-directory denial.
//
// config.d/ holds every provider API key. It was readable because filterPaths still
// named `config.json` from the single-file config era, and the filterExtensions list
// never matched (extname() yields ".jsonc", the config listed "jsonc"). Anything this
// service returns can reach an LLM prompt, so the denial lives in code and must hold
// even for privileged (noCheck) callers.

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { FileReadService } from './FileReadService';

const ROOT = process.cwd();

function svc() {
  // Deliberately empty filters: the denial must not depend on configuration.
  return new FileReadService({ root: ROOT, filterPaths: [], filterExtensions: [] });
}

describe('FileReadService secret-path denial', () => {
  it('refuses to resolve a file inside config.d', () => {
    expect(svc().resolvePath('config.d/ai.jsonc').error).toBe('unavailable path');
  });

  it('refuses config.d even for privileged noCheck callers', () => {
    expect(svc().resolvePath('config.d/ai.jsonc', true).error).toBe('unavailable path');
    expect(svc().resolvePath(join(ROOT, 'config.d', 'ai.jsonc'), true).error).toBe('unavailable path');
  });

  it('refuses the config.d directory itself', () => {
    expect(svc().resolvePath('config.d').error).toBe('unavailable path');
  });

  it('reports the path as unsafe regardless of noCheck', () => {
    const s = svc();
    const p = join(ROOT, 'config.d', 'ai.jsonc');
    expect(s.isPathSafe(p)).toBe(false);
    expect(s.isPathSafe(p, ROOT, true)).toBe(false);
  });

  it('readFile on config.d fails without returning content', () => {
    const result = svc().readFile('config.d/ai.jsonc');
    expect(result.success).toBe(false);
    expect(result.content ?? '').toBe('');
  });

  it('matches whole segments only — a config.dist sibling is unaffected', () => {
    expect(svc().resolvePath('config.dist/notes.md').error).toBeUndefined();
  });

  it('still allows ordinary project files', () => {
    expect(svc().resolvePath('package.json').error).toBeUndefined();
  });

  it('still blocks traversal outside the project root', () => {
    expect(svc().resolvePath('../../etc/passwd').error).toBeDefined();
  });

  // End-to-end against the real deployed config shape, including the two defects
  // that let secrets through: filterPaths still names the single-file `config.json`,
  // and filterExtensions never matches because extname() returns a leading dot.
  it('blocks config.d under the live config, whose own filters do not cover it', () => {
    const live = new FileReadService({
      root: process.cwd(),
      filterPaths: ['node_modules', 'output', 'dist', 'data', 'logs', 'config.json'],
      filterExtensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'jsonc', 'txt', 'log'],
    });

    // Sanity: neither configured filter would have stopped this path on its own.
    expect('config.d/ai.jsonc'.includes('config.json')).toBe(false);
    expect(['jpg', 'jsonc', 'txt'].includes('.jsonc')).toBe(false);

    const result = live.readFile('config.d/ai.jsonc');
    expect(result.success).toBe(false);
    expect(result.content ?? '').toBe('');
  });
});

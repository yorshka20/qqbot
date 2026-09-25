// Tests for FileReadService path guards, focused on the secret-directory denial.
//
// config.d/ holds every provider API key. It was readable because filterPaths still
// named `config.json` from the single-file config era, and the filterExtensions list
// did not match (extname() yields ".jsonc", the config listed "jsonc"; comparison now
// strips that dot). Anything this service returns can reach an LLM prompt, so the
// denial lives in code and must hold even for privileged (noCheck) callers.

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileReadService } from './FileReadService';
import { createFileReadService } from '@/services/file/__tests__/createFileReadService';

const ROOT = process.cwd();

function svc() {
  // Deliberately empty filters: the denial must not depend on configuration.
  return createFileReadService({ root: ROOT, filterPaths: [], filterExtensions: [] });
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

  it('refuses .git/config but still allows other files in .git', () => {
    const s = svc();
    expect(s.resolvePath('.git/config', false, true).error).toBe('unavailable path');
    expect(s.resolvePath('.git/credentials', false, true).error).toBe('unavailable path');
    expect(s.resolvePath('.git/HEAD', false, true).error).toBeUndefined();
    expect(s.resolvePath('.git', false, true).error).toBeUndefined();
    expect(s.touchesSecret('HEAD:.git/config')).toBe(true);
    expect(s.touchesSecret('HEAD:config.d/ai.jsonc')).toBe(true);
    expect(s.touchesSecret('HEAD:package.json')).toBe(false);
  });

  it('still blocks traversal outside the project root', () => {
    expect(svc().resolvePath('../../etc/passwd').error).toBeDefined();
  });

  // filterPaths still names the single-file `config.json`, so it does not cover config.d.
  // Extension denial is a separate gate and is not what blocks this path.
  it('blocks config.d under the live config, whose path filters do not cover it', () => {
    const live = createFileReadService({
      root: process.cwd(),
      filterPaths: ['node_modules', 'output', 'dist', 'data', 'logs', 'config.json'],
      filterExtensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'jsonc', 'txt', 'log'],
    });

    expect('config.d/ai.jsonc'.includes('config.json')).toBe(false);

    const result = live.readFile('config.d/ai.jsonc');
    expect(result.success).toBe(false);
    expect(result.content ?? '').toBe('');
  });
});

describe('FileReadService extension filter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fileread-ext-'));
  writeFileSync(join(dir, 'notes.jsonc'), '{}\n');
  writeFileSync(join(dir, 'notes.md'), 'ok\n');
  writeFileSync(join(dir, 'README'), 'plain\n');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks a bare configured suffix even though extname() includes a dot', () => {
    const svc = createFileReadService({
      root: dir,
      filterPaths: [],
      filterExtensions: ['jsonc'],
    });

    const blocked = svc.readFile('notes.jsonc');
    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe('unsupported file extension');
    expect(blocked.content).toBe('');

    const allowed = svc.readFile('notes.md');
    expect(allowed.success).toBe(true);
    expect(allowed.content).toContain('ok');
  });

  it('treats a dotted or uppercase config entry as the same suffix', () => {
    const svc = createFileReadService({
      root: dir,
      filterPaths: [],
      filterExtensions: ['.JSONC'],
    });

    expect(svc.readFile('notes.jsonc').error).toBe('unsupported file extension');
    expect(svc.readFile('README').success).toBe(true);
    expect(svc.readFile('README').content).toContain('plain');
  });
});

describe('FileReadService default content cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fileread-cap-'));
  const reader = createFileReadService({ root: dir, filterPaths: [], filterExtensions: [] });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a file at the default cap intact', () => {
    writeFileSync(join(dir, 'exact.txt'), 'x'.repeat(15000));
    const result = reader.readFile('exact.txt');
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('x'.repeat(15000));
  });

  it('slices past the default cap and marks the cut', () => {
    writeFileSync(join(dir, 'over.txt'), `${'x'.repeat(15000)}Z`);
    const result = reader.readFile('over.txt');
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith('x'.repeat(15000))).toBe(true);
    expect(result.content.endsWith('...(内容已截断)')).toBe(true);
    expect(result.content.includes('Z')).toBe(false);
  });
});

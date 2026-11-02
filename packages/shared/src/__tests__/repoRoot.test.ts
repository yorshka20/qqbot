import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getRepoRoot, resolveFromRepoRoot } from '../repoRoot';

describe('resolveFromRepoRoot', () => {
  const originalCwd = process.cwd();
  let elsewhere: string | null = null;

  afterEach(() => {
    process.chdir(originalCwd);
    if (elsewhere) {
      rmSync(elsewhere, { recursive: true, force: true });
      elsewhere = null;
    }
  });

  it('keeps an absolute path as it is', () => {
    expect(resolveFromRepoRoot('/var/lib/qqbot/bot.db')).toBe('/var/lib/qqbot/bot.db');
  });

  it('takes a relative path from the repo root and normalises it', () => {
    const root = getRepoRoot();
    expect(resolveFromRepoRoot('data/bot.db')).toBe(join(root, 'data', 'bot.db'));
    expect(resolveFromRepoRoot('./data/persona')).toBe(join(root, 'data', 'persona'));
    expect(resolveFromRepoRoot('../sibling/data')).toBe(resolve(root, '..', 'sibling', 'data'));
  });

  it('does not depend on the directory the process was started from', () => {
    elsewhere = mkdtempSync(join(tmpdir(), 'repo-root-cwd-'));
    process.chdir(elsewhere);
    expect(resolveFromRepoRoot('data/bot.db')).toBe(join(getRepoRoot(), 'data', 'bot.db'));
  });
});

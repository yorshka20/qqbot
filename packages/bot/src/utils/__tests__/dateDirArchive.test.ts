// Tests for the shared YYYY-MM-DD directory archiver: retention window, batching,
// archive naming, and removal of the archived originals.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDateDirs } from '../dateDirArchive';

let root: string;

/** Create a day directory `daysAgo` days before today, holding one file. */
function makeDayDir(daysAgo: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'dump.md'), `content for ${name}`, 'utf-8');
  return name;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'date-dir-archive-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('archiveDateDirs', () => {
  it('zips day directories outside the retention window and removes the originals', async () => {
    const recent = [makeDayDir(0), makeDayDir(3), makeDayDir(6)];
    const old = [makeDayDir(8), makeDayDir(9), makeDayDir(10)];

    const archiveDir = join(root, 'archive');
    await archiveDateDirs({
      sourceDir: root,
      archiveDir,
      retainDays: 7,
      batchDays: 7,
      format: 'zip',
      deleteAfterArchive: true,
      logLabel: '[test]',
    });

    for (const name of recent) {
      expect(existsSync(join(root, name))).toBe(true);
    }
    for (const name of old) {
      expect(existsSync(join(root, name))).toBe(false);
    }

    const archives = readdirSync(archiveDir);
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^\d{4}-\d{4}-\d{4}\.zip$/);
  });

  it('splits eligible days into batchDays-sized archives', async () => {
    for (let i = 8; i <= 20; i++) makeDayDir(i);

    const archiveDir = join(root, 'archive');
    await archiveDateDirs({
      sourceDir: root,
      archiveDir,
      retainDays: 7,
      batchDays: 7,
      format: 'zip',
      deleteAfterArchive: true,
      logLabel: '[test]',
    });

    // 13 eligible days -> two batches (7 + 6).
    expect(readdirSync(archiveDir)).toHaveLength(2);
    expect(readdirSync(root).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))).toHaveLength(0);
  });

  it('leaves everything alone when nothing is old enough', async () => {
    const recent = [makeDayDir(0), makeDayDir(6)];
    const archiveDir = join(root, 'archive');

    await archiveDateDirs({
      sourceDir: root,
      archiveDir,
      retainDays: 7,
      batchDays: 7,
      format: 'zip',
      deleteAfterArchive: true,
      logLabel: '[test]',
    });

    for (const name of recent) {
      expect(existsSync(join(root, name))).toBe(true);
    }
    expect(existsSync(archiveDir) ? readdirSync(archiveDir) : []).toHaveLength(0);
  });

  it('keeps tar.gz behaviour for the logs pipeline', async () => {
    makeDayDir(8);
    const archiveDir = join(root, 'archive');

    await archiveDateDirs({
      sourceDir: root,
      archiveDir,
      retainDays: 3,
      batchDays: 3,
      format: 'tar.gz',
      deleteAfterArchive: false,
      logLabel: '[test]',
    });

    expect(readdirSync(archiveDir)[0]).toMatch(/^\d{4}-\d{4}-\d{4}\.tar\.gz$/);
    // deleteAfterArchive: false keeps the source day directory in place.
    expect(readdirSync(root).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))).toHaveLength(1);
  });
});

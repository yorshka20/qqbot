import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock, readDaemonLock } from '../lock';

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cluster-daemon-lock-')), 'daemon.lock');
}

describe('acquireDaemonLock', () => {
  test('writes this pid and releases on the returned callback', () => {
    const path = lockPath();
    const release = acquireDaemonLock(path);
    expect(readDaemonLock(path)?.pid).toBe(process.pid);
    release();
    expect(existsSync(path)).toBe(false);
  });

  test('refuses while a live daemon holds the lock', () => {
    const path = lockPath();
    const release = acquireDaemonLock(path);
    expect(() => acquireDaemonLock(path)).toThrow(/another cluster daemon/);
    release();
  });

  test('reclaims a lock whose pid is dead or predates the boot', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() }));
    acquireDaemonLock(path)();
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z' }));
    const release = acquireDaemonLock(path);
    expect(readDaemonLock(path)?.pid).toBe(process.pid);
    release();
  });
});

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';

interface DaemonLockState {
  pid: number;
  startedAt: string;
}

/**
 * Take `<stateDir>/daemon.lock` for this process, so a second daemon on the same state
 * directory refuses to start instead of racing the first for the SQLite file and the port.
 * A lock left behind by a daemon that died (or by a previous boot) is reclaimed.
 */
export function acquireDaemonLock(path: string): () => void {
  const state: DaemonLockState = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      return () => releaseDaemonLock(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    const holder = readDaemonLock(path);
    if (holder && mayBeRunning(holder)) {
      throw new Error(`another cluster daemon (pid ${holder.pid}, started ${holder.startedAt}) holds ${path}`);
    }
    rmSync(path, { force: true });
  }
  throw new Error(`could not take ${path}`);
}

function releaseDaemonLock(path: string): void {
  if (readDaemonLock(path)?.pid === process.pid) {
    rmSync(path, { force: true });
  }
}

export function readDaemonLock(path: string): DaemonLockState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonLockState;
  } catch {
    return null;
  }
}

/**
 * Whether the daemon a lock describes can still be running: its pid is alive and it started
 * after the last boot (a lock that survived a reboot may name a reused pid).
 */
export function mayBeRunning(state: DaemonLockState): boolean {
  const bootedAt = Date.now() - uptime() * 1000;
  return Date.parse(state.startedAt) > bootedAt && isAlive(state.pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

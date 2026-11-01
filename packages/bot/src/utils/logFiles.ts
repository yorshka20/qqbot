// Layout of the bot's log files, and following them as they grow.
//
// The logger writes `logs/<YYYY-MM-DD>/<YYYY-MM-DD>-<HH-MM-SS>.log`: a new file at every process
// start and at every local midnight, so the names sort chronologically. This module imports
// nothing with side effects (unlike the logger, which opens a file when imported), so tooling
// outside the bot process can follow the same files.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getRepoRoot } from './repoRoot';

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const LOG_FILE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.log$/;
const POLL_MS = 500;

export function botLogsDir(): string {
  return join(getRepoRoot(), 'logs');
}

/** YYYY-MM-DD in local time. */
export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function logFilePathAt(logsDir: string, date: Date): string {
  const day = localDateString(date);
  const time = date.toTimeString().split(' ')[0].replace(/:/g, '-');
  return join(logsDir, day, `${day}-${time}.log`);
}

/** The newest log file — the one the most recently started bot process writes to — or null. */
export function findLatestLogFile(logsDir: string): string | null {
  if (!existsSync(logsDir)) {
    return null;
  }
  const days = readdirSync(logsDir)
    .filter((name) => DATE_DIR.test(name))
    .sort()
    .reverse();
  for (const day of days) {
    const files = readdirSync(join(logsDir, day))
      .filter((name) => LOG_FILE.test(name))
      .sort();
    if (files.length > 0) {
      return join(logsDir, day, files[files.length - 1]);
    }
  }
  return null;
}

export interface FollowLogOptions {
  signal: AbortSignal;
  initialLines: number;
}

/**
 * Emit every line appended to the newest log file until `signal` aborts, moving on to a newer
 * file when one appears (a restart, or the logger's midnight rollover) after draining the old
 * one. `initialLines` lines of the file that is newest at the start are emitted first.
 */
export async function followLatestLog(
  logsDir: string,
  onLine: (line: string) => void,
  { signal, initialLines }: FollowLogOptions,
): Promise<void> {
  let reader: LogReader | null = null;
  const first = findLatestLogFile(logsDir);
  if (first) {
    const content = readFileSync(first);
    if (initialLines > 0) {
      for (const line of content.toString('utf8').split('\n').slice(0, -1).slice(-initialLines)) {
        onLine(line);
      }
    }
    reader = openReader(first, onLine, content.length);
  }
  while (!signal.aborted) {
    await sleep(POLL_MS, undefined, { signal }).catch(() => {});
    reader?.drain();
    const latest = findLatestLogFile(logsDir);
    if (latest !== (reader?.path ?? null)) {
      reader?.close();
      reader = openReader(latest, onLine, 0);
      reader?.drain();
    }
  }
  reader?.close();
}

interface LogReader {
  path: string;
  drain(): void;
  close(): void;
}

/** Reads `path` from byte `offset` onward on each `drain()`, emitting whole lines. */
function openReader(path: string | null, onLine: (line: string) => void, offset: number): LogReader | null {
  if (!path) {
    return null;
  }
  let position = offset;
  let pending = '';
  const decoder = new TextDecoder();
  const buffer = Buffer.alloc(64 * 1024);
  return {
    path,
    drain() {
      if (!existsSync(path)) {
        return;
      }
      const fd = openSync(path, 'r');
      try {
        while (true) {
          const read = readSync(fd, buffer, 0, buffer.length, position);
          if (read === 0) {
            break;
          }
          position += read;
          pending += decoder.decode(buffer.subarray(0, read), { stream: true });
        }
      } finally {
        closeSync(fd);
      }
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        onLine(line);
      }
    },
    close() {
      if (pending) {
        onLine(pending);
        pending = '';
      }
    },
  };
}

// Layout of the bot's log files, and following them as they grow.
//
// The logger writes `logs/<YYYY-MM-DD>/<YYYY-MM-DD>-<HH-MM-SS>.log`: a new file at a process's
// first entry and at its first entry of each local day. Every process that logs gets files of its
// own, so which one is the bot's is recorded in `logs/current`, not inferred from the names. This
// module imports nothing with side effects, so tooling outside the bot process can follow it.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getRepoRoot } from './repoRoot';

const POLL_MS = 500;

/**
 * Where this process writes its log files. `QQBOT_LOGS_DIR` moves them: the cluster daemon runs
 * beside the bot from the same checkout and keeps its own tree under `logs/cluster/`.
 */
export function botLogsDir(): string {
  const override = process.env.QQBOT_LOGS_DIR?.trim();
  return override ? override : join(getRepoRoot(), 'logs');
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

/**
 * `<logsDir>/current` holds the path of the file the bot writes to now. The bot keeps it up to
 * date (`recordCurrentLogFile`); nothing else writes it. Followers read it instead of guessing
 * from file names, because any process that imports the logger and logs gets a file of its own.
 */
export function currentLogPointer(logsDir: string): string {
  return join(logsDir, 'current');
}

/** Written whole and renamed into place, so a reader never sees half a path. */
export function recordCurrentLogFile(logsDir: string, path: string): void {
  const pointer = currentLogPointer(logsDir);
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(`${pointer}.next`, path);
  renameSync(`${pointer}.next`, pointer);
}

/** The bot's current log file, or null before any bot has recorded one. */
export function readCurrentLogFile(logsDir: string): string | null {
  const pointer = currentLogPointer(logsDir);
  if (!existsSync(pointer)) {
    return null;
  }
  return readFileSync(pointer, 'utf8').trim() || null;
}

export interface FollowLogOptions {
  signal: AbortSignal;
  initialLines: number;
  pollMs?: number;
}

/**
 * Emit every line appended to the bot's current log file until `signal` aborts, moving on when
 * the bot records another (a restart, or its first entry of a new day) after draining the old
 * one. `initialLines` lines of the file that is current at the start are emitted first.
 */
export async function followCurrentLog(
  logsDir: string,
  onLine: (line: string) => void,
  { signal, initialLines, pollMs = POLL_MS }: FollowLogOptions,
): Promise<void> {
  let reader: LogReader | null = null;
  const first = readCurrentLogFile(logsDir);
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
    await sleep(pollMs, undefined, { signal }).catch(() => {});
    reader?.drain();
    const current = readCurrentLogFile(logsDir);
    if (current !== (reader?.path ?? null)) {
      reader?.close();
      reader = openReader(current, onLine, 0);
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

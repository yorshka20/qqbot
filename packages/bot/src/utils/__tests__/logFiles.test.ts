// The log-file layout shared with the logger, and following the newest file as it grows and rolls over.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLatestLogFile, followLatestLog, logFilePathAt } from '../logFiles';

let logsDir: string;

function writeLog(day: string, time: string, content: string): string {
  mkdirSync(join(logsDir, day), { recursive: true });
  const path = join(logsDir, day, `${day}-${time}.log`);
  writeFileSync(path, content);
  return path;
}

/** Run the follower until `until` holds for the lines seen so far, driving it with `steps`. */
async function follow(initialLines: number, steps: Array<() => void>, until: (lines: string[]) => boolean) {
  const lines: string[] = [];
  const abort = new AbortController();
  const done = followLatestLog(logsDir, (line) => lines.push(line), { signal: abort.signal, initialLines });
  for (const step of steps) {
    await Bun.sleep(50);
    step();
    await Bun.sleep(700);
  }
  const deadline = Date.now() + 3000;
  while (!until(lines) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  abort.abort();
  await done;
  return lines;
}

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'qqbot-log-files-'));
});

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

describe('logFilePathAt', () => {
  it('names the file after the local date and time', () => {
    expect(logFilePathAt('/logs', new Date(2026, 0, 5, 7, 8, 9))).toBe(join('/logs', '2026-01-05', '2026-01-05-07-08-09.log'));
  });
});

describe('findLatestLogFile', () => {
  it('picks the newest file of the newest day, ignoring anything not named like a log', () => {
    writeLog('2026-01-05', '23-00-00', '');
    writeLog('2026-01-06', '01-00-00', '');
    const latest = writeLog('2026-01-06', '09-30-00', '');
    writeFileSync(join(logsDir, '2026-01-06', 'notes.txt'), '');
    mkdirSync(join(logsDir, 'archive'));
    mkdirSync(join(logsDir, '2026-01-07'));
    expect(findLatestLogFile(logsDir)).toBe(latest);
  });

  it('is null for a missing or empty directory', () => {
    expect(findLatestLogFile(join(logsDir, 'missing'))).toBeNull();
    expect(findLatestLogFile(logsDir)).toBeNull();
  });
});

describe('followLatestLog', () => {
  it('emits the requested tail, then whole lines as they are appended', async () => {
    const path = writeLog('2026-01-06', '09-00-00', 'one\ntwo\nthree\n');
    const lines = await follow(
      2,
      [() => appendFileSync(path, 'four\nfi'), () => appendFileSync(path, 've\n')],
      (seen) => seen.includes('five'),
    );
    expect(lines).toEqual(['two', 'three', 'four', 'five']);
  });

  it('drains the old file, then moves on to a newer one from its start', async () => {
    const first = writeLog('2026-01-06', '09-00-00', 'old\n');
    const lines = await follow(
      0,
      [
        () => {
          appendFileSync(first, 'last of first\n');
          writeLog('2026-01-07', '00-00-00', 'new day\n');
        },
      ],
      (seen) => seen.includes('new day'),
    );
    expect(lines).toEqual(['last of first', 'new day']);
  });

  it('waits for the first file when there is none yet', async () => {
    const lines = await follow(5, [() => writeLog('2026-01-06', '09-00-00', 'first line\n')], (seen) =>
      seen.includes('first line'),
    );
    expect(lines).toEqual(['first line']);
  });
});

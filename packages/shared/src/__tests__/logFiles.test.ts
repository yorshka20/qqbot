// The log-file layout shared with the logger, and following the bot's current file as it grows and rolls over.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followCurrentLog, logFilePathAt, readCurrentLogFile, recordCurrentLogFile } from '../logFiles';

let logsDir: string;

function writeLog(day: string, time: string, content: string): string {
  mkdirSync(join(logsDir, day), { recursive: true });
  const path = join(logsDir, day, `${day}-${time}.log`);
  writeFileSync(path, content);
  return path;
}

const POLL_MS = 5;

/** Run the follower until `until` holds for the lines seen so far, driving it with `steps`. */
async function follow(initialLines: number, steps: Array<() => void>, until: (lines: string[]) => boolean) {
  const lines: string[] = [];
  const abort = new AbortController();
  const done = followCurrentLog(logsDir, (line) => lines.push(line), {
    signal: abort.signal,
    initialLines,
    pollMs: POLL_MS,
  });
  for (const step of steps) {
    await Bun.sleep(POLL_MS * 4);
    step();
    await Bun.sleep(POLL_MS * 4);
  }
  const deadline = Date.now() + 3000;
  while (!until(lines) && Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
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

describe('current log pointer', () => {
  it('reads back the path the bot recorded, and null before one is', () => {
    expect(readCurrentLogFile(logsDir)).toBeNull();
    const path = writeLog('2026-01-06', '09-30-00', '');
    recordCurrentLogFile(logsDir, path);
    expect(readCurrentLogFile(logsDir)).toBe(path);
  });
});

describe('followCurrentLog', () => {
  it('emits the requested tail, then whole lines as they are appended', async () => {
    const path = writeLog('2026-01-06', '09-00-00', 'one\ntwo\nthree\n');
    recordCurrentLogFile(logsDir, path);
    const lines = await follow(
      2,
      [() => appendFileSync(path, 'four\nfi'), () => appendFileSync(path, 've\n')],
      (seen) => seen.includes('five'),
    );
    expect(lines).toEqual(['two', 'three', 'four', 'five']);
  });

  it('drains the old file, then moves on to the one the bot records next, from its start', async () => {
    const first = writeLog('2026-01-06', '09-00-00', 'old\n');
    recordCurrentLogFile(logsDir, first);
    const lines = await follow(
      0,
      [
        () => {
          appendFileSync(first, 'last of first\n');
          recordCurrentLogFile(logsDir, writeLog('2026-01-07', '00-00-00', 'new day\n'));
        },
      ],
      (seen) => seen.includes('new day'),
    );
    expect(lines).toEqual(['last of first', 'new day']);
  });

  it('stays on the bot file when another process writes a newer one', async () => {
    const bot = writeLog('2026-01-06', '09-00-00', '');
    recordCurrentLogFile(logsDir, bot);
    const lines = await follow(
      0,
      [() => writeLog('2026-01-06', '09-05-00', 'a cli logged\n'), () => appendFileSync(bot, 'bot again\n')],
      (seen) => seen.includes('bot again'),
    );
    expect(lines).toEqual(['bot again']);
  });

  it('waits for the bot to record its first file', async () => {
    const lines = await follow(
      5,
      [() => recordCurrentLogFile(logsDir, writeLog('2026-01-06', '09-00-00', 'first line\n'))],
      (seen) => seen.includes('first line'),
    );
    expect(lines).toEqual(['first line']);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogTail } from '../LogTail';

const INTERVAL_MS = 20;

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('LogTail', () => {
  const dirs: string[] = [];
  const tails: LogTail[] = [];

  function setup(initial?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'log-tail-'));
    dirs.push(dir);
    const path = join(dir, 'worker.out.log');
    if (initial !== undefined) writeFileSync(path, initial);
    const lines: string[] = [];
    const chunks: string[] = [];
    const tail = new LogTail(
      path,
      (line) => lines.push(line),
      (text) => chunks.push(text),
      INTERVAL_MS,
    );
    tails.push(tail);
    return { path, tail, lines, chunks };
  }

  afterEach(() => {
    for (const tail of tails.splice(0)) tail.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('splits appended text into lines and keeps a half line until it is finished', async () => {
    const { path, tail, lines, chunks } = setup();
    tail.start();

    appendFileSync(path, 'first\nsecond part ');
    await waitFor(() => chunks.length === 1);
    expect(chunks).toEqual(['first\nsecond part ']);
    expect(lines).toEqual(['first']);

    appendFileSync(path, 'continues\nthird\n');
    await waitFor(() => chunks.length === 2);
    expect(lines).toEqual(['first', 'second part continues', 'third']);
    expect(chunks.join('')).toBe('first\nsecond part continues\nthird\n');
  });

  test('a half line is also kept across more than one poll', async () => {
    const { path, tail, lines, chunks } = setup();
    tail.start();

    appendFileSync(path, 'a');
    await waitFor(() => chunks.length === 1);
    appendFileSync(path, 'b');
    await waitFor(() => chunks.length === 2);
    expect(lines).toEqual([]);

    appendFileSync(path, 'c\n');
    await waitFor(() => lines.length === 1);
    expect(lines).toEqual(['abc']);
  });

  test('start() skips what the file already holds; start(true) reads it', async () => {
    const skipping = setup('old line\n');
    skipping.tail.start();
    appendFileSync(skipping.path, 'new line\n');
    await waitFor(() => skipping.lines.length === 1);
    expect(skipping.lines).toEqual(['new line']);
    expect(skipping.chunks).toEqual(['new line\n']);

    const reading = setup('old line\n');
    reading.tail.start(true);
    await waitFor(() => reading.lines.length === 1);
    expect(reading.lines).toEqual(['old line']);
  });

  test('stop() reads what was appended since the last poll and flushes the unfinished line', () => {
    const { path, tail, lines, chunks } = setup();
    tail.start();

    appendFileSync(path, 'done\nno newline at the end');
    tail.stop();

    expect(chunks).toEqual(['done\nno newline at the end']);
    expect(lines).toEqual(['done', 'no newline at the end']);
  });

  test('blank lines are not reported as lines but still count as output', async () => {
    const { path, tail, lines, chunks } = setup();
    tail.start();

    appendFileSync(path, '\n   \nreal\n');
    await waitFor(() => lines.length === 1);
    expect(lines).toEqual(['real']);
    expect(chunks).toEqual(['\n   \nreal\n']);
  });

  test('a file that does not exist yet is picked up once it appears', async () => {
    const { path, tail, lines } = setup();
    tail.start();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS * 3));

    writeFileSync(path, 'late\n');
    await waitFor(() => lines.length === 1);
    expect(lines).toEqual(['late']);
  });

  test('start() is idempotent and stop() can be called again without effect', () => {
    const { path, tail, lines } = setup();
    tail.start();
    tail.start();
    appendFileSync(path, 'once\n');
    tail.stop();
    tail.stop();
    expect(lines).toEqual(['once']);
  });
});

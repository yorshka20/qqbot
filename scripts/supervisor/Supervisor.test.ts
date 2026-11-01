// Supervisor against a real child process (__fixtures__/fakeBot.ts): restarts and their throttle,
// clean and forced stops, requests the bot sends over IPC, holding it stopped.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supervisorFiles } from '../../packages/bot/src/utils/supervisorProtocol';
import type { AppDefinition } from './app';
import { restartDelay, Supervisor } from './Supervisor';

const FAKE_BOT = fileURLToPath(new URL('./__fixtures__/fakeBot.ts', import.meta.url));
const THROTTLE_MS = 600;
const STOP_TIMEOUT_MS = 500;

let dir: string;
let eventsFile: string;
let supervisor: Supervisor | null;
let logged: string[];

interface BotEvent {
  event: string;
  pid: number;
  at: number;
}

function events(): BotEvent[] {
  if (!existsSync(eventsFile)) {
    return [];
  }
  return readFileSync(eventsFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [event, pid, at] = line.split(' ');
      return { event, pid: Number(pid), at: Number(at) };
    });
}

const starts = () => events().filter((e) => e.event === 'start');

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out; events: ${JSON.stringify(events())}; log: ${logged.join(' | ')}`);
    }
    await Bun.sleep(25);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startSupervisor(mode: string): Supervisor {
  const app: AppDefinition = {
    name: 'fake-bot',
    cmd: [process.execPath, FAKE_BOT, eventsFile, mode],
    deployCmd: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(eventsFile)}, 'deploy 0 0\\n')`],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    restartThrottleMs: THROTTLE_MS,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    files: supervisorFiles(dir),
  };
  supervisor = new Supervisor(app, (line) => logged.push(line));
  supervisor.start();
  return supervisor;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qqbot-supervisor-'));
  eventsFile = join(dir, 'events.log');
  logged = [];
  supervisor = null;
});

afterEach(async () => {
  await supervisor?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('restartDelay', () => {
  it('waits out the rest of the throttle after a short run, and not at all after a long one', () => {
    expect(restartDelay(1000, 1100, 400)).toBe(300);
    expect(restartDelay(1000, 1400, 400)).toBe(0);
    expect(restartDelay(1000, 9000, 400)).toBe(0);
  });
});

describe('Supervisor', () => {
  it('runs the bot and stops it cleanly with a shutdown message', async () => {
    const s = startSupervisor('serve');
    await waitFor(() => starts().length === 1);
    expect(s.status()).toMatchObject({ state: 'running', pid: starts()[0].pid, starts: 1 });

    await s.close();
    expect(events().map((e) => e.event)).toEqual(['start', 'shutdown']);
    expect(s.status()).toMatchObject({ state: 'stopped', pid: null, lastExit: { code: 0 } });
  });

  it('starts a bot that keeps crashing again no sooner than the throttle allows', async () => {
    const s = startSupervisor('crash');
    await waitFor(() => starts().length >= 3, 8000);
    const [first, second, third] = starts();
    // Measured from start to start, with a little room for timer and spawn jitter.
    expect(second.at - first.at).toBeGreaterThanOrEqual(THROTTLE_MS - 50);
    expect(third.at - second.at).toBeGreaterThanOrEqual(THROTTLE_MS - 50);
    expect(s.status().lastExit?.code).toBe(1);
  });

  it('restarts at once on request, whatever the throttle', async () => {
    const s = startSupervisor('serve');
    await waitFor(() => starts().length === 1);
    const before = Date.now();
    await s.restart();
    await waitFor(() => starts().length === 2);
    expect(starts()[1].pid).not.toBe(starts()[0].pid);
    expect(starts()[1].at - before).toBeLessThan(THROTTLE_MS);
    expect(events().map((e) => e.event)).toEqual(['start', 'shutdown', 'start']);
  });

  it('kills a bot that does not exit within the stop timeout', async () => {
    const s = startSupervisor('stubborn');
    await waitFor(() => starts().length === 1);
    const { pid } = starts()[0];
    const before = Date.now();
    await s.close();
    expect(Date.now() - before).toBeGreaterThanOrEqual(STOP_TIMEOUT_MS - 50);
    expect(isAlive(pid)).toBe(false);
    expect(logged.some((line) => line.includes('killing it'))).toBe(true);
  });

  it('restarts when the bot asks over IPC', async () => {
    startSupervisor('ask-restart');
    await waitFor(() => starts().length === 2);
    expect(events().map((e) => e.event)).toEqual(['start', 'shutdown', 'start']);
  });

  it('runs a deploy when the bot asks over IPC, leaving the bot to the deploy', async () => {
    const s = startSupervisor('ask-deploy');
    await waitFor(() => events().some((e) => e.event === 'deploy'));
    await waitFor(() => !s.status().deploying);
    expect(s.status().state).toBe('running');
  });

  it('keeps a held bot stopped past the throttle, until released', async () => {
    const s = startSupervisor('serve');
    await waitFor(() => starts().length === 1);
    await s.hold();
    expect(s.status().state).toBe('held');
    await Bun.sleep(THROTTLE_MS + 200);
    expect(starts()).toHaveLength(1);

    await s.release();
    await waitFor(() => starts().length === 2);
    expect(s.status().state).toBe('running');
  });

  it.skipIf(process.platform === 'win32')('kills what the bot left in its process group once it has exited', async () => {
    const s = startSupervisor('grandchild');
    await waitFor(() => events().some((e) => e.event === 'grandchild'));
    const grandchild = events().find((e) => e.event === 'grandchild')?.pid ?? 0;
    expect(isAlive(grandchild)).toBe(true);
    await s.close();
    await waitFor(() => !isAlive(grandchild), 2000);
  });
});

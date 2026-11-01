// The supervisor CLI's argument parsing, the macOS launch-context warning, the control routes and
// the state-file checks.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, localNetworkWarning, parseCliArgs, UsageError } from './cli';
import { createState, mayBeRunning, readState } from './client';
import { controlHandler } from './control';
import type { BotStatus } from './Supervisor';

describe('parseCliArgs', () => {
  it('accepts every command, with --lines / -n', () => {
    for (const command of COMMANDS) {
      expect(parseCliArgs([command])).toEqual({ command, lines: 50 });
    }
    expect(parseCliArgs(['logs', '--lines', '200'])).toEqual({ command: 'logs', lines: 200 });
    expect(parseCliArgs(['logs', '-n', '0'])).toEqual({ command: 'logs', lines: 0 });
  });

  it('refuses a missing, unknown or extra command, an unknown option and a bad count', () => {
    for (const argv of [[], ['reload'], ['start', 'stop'], ['status', '--force'], ['logs', '-n', 'x'], ['logs', '-n', '-3']]) {
      expect(() => parseCliArgs(argv)).toThrow(UsageError);
    }
  });
});

describe('localNetworkWarning', () => {
  it('stays quiet off macOS, in Terminal and over SSH', () => {
    expect(localNetworkWarning({ __CFBundleIdentifier: 'com.example.ide' }, 'win32')).toBeNull();
    expect(localNetworkWarning({ __CFBundleIdentifier: 'com.apple.Terminal' }, 'darwin')).toBeNull();
    expect(localNetworkWarning({ SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' }, 'darwin')).toBeNull();
  });

  it('names the app the supervisor was started from otherwise', () => {
    expect(localNetworkWarning({ __CFBundleIdentifier: 'com.example.ide' }, 'darwin')).toContain('com.example.ide');
    expect(localNetworkWarning({}, 'darwin')).toContain('outside Terminal');
  });
});

describe('controlHandler', () => {
  const status: BotStatus = {
    state: 'running',
    pid: 42,
    startedAt: null,
    starts: 1,
    lastExit: null,
    nextStartAt: null,
    deploying: false,
  };

  function harness() {
    const calls: string[] = [];
    const fake = {
      status: () => status,
      restart: async () => void calls.push('restart'),
      hold: async () => void calls.push('hold'),
      release: async () => void calls.push('release'),
      close: async () => void calls.push('close'),
    };
    const handle = controlHandler(fake, 'secret', () => calls.push('stopped'));
    const call = (method: string, path: string, token = 'secret') =>
      handle(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${token}` } }));
    return { calls, call };
  }

  it('refuses a request without the token', async () => {
    const { calls, call } = harness();
    expect((await call('POST', '/restart', 'wrong')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('maps each route to its operation and answers with the status', async () => {
    const { calls, call } = harness();
    expect(await (await call('GET', '/status')).json()).toEqual(status);
    await call('POST', '/restart');
    await call('POST', '/bot/stop');
    await call('POST', '/bot/start');
    await call('POST', '/stop');
    await Bun.sleep(10);
    expect(calls).toEqual(['restart', 'hold', 'release', 'close', 'stopped']);
    expect((await call('GET', '/restart')).status).toBe(404);
  });
});

describe('state file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qqbot-supervisor-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is created once, and reads back', () => {
    const path = join(dir, 'state.json');
    const state = { pid: process.pid, port: 1234, token: 't', startedAt: new Date().toISOString() };
    createState(path, state);
    expect(() => createState(path, state)).toThrow();
    expect(readState(path)).toEqual(state);
  });

  it('reads as absent when unparsable', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{"pid": 1');
    expect(readState(path)).toBeNull();
  });

  it('names a supervisor that may run only for a live pid started since the last boot', () => {
    const now = new Date().toISOString();
    expect(mayBeRunning({ pid: process.pid, port: 1, token: 't', startedAt: now })).toBe(true);
    expect(mayBeRunning({ pid: process.pid, port: 1, token: 't', startedAt: '2000-01-01T00:00:00.000Z' })).toBe(false);
    expect(mayBeRunning({ pid: 2 ** 22 + 12345, port: 1, token: 't', startedAt: now })).toBe(false);
  });
});

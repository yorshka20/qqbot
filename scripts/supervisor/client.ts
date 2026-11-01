// Finding and talking to a running supervisor. Its state file names its pid, its control port on
// 127.0.0.1 and the token every request must carry; only the user who started it can read the file.

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { SupervisorFiles } from '../../packages/bot/src/utils/supervisorProtocol';
import type { AppDefinition } from './app';
import type { BotStatus } from './Supervisor';

export interface SupervisorState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

const DAEMON = fileURLToPath(new URL('./daemon.ts', import.meta.url));
const STATUS_TIMEOUT_MS = 3000;
// A restart or stop may wait out the bot's stop timeout before the kill; leave room above it.
const OPERATION_TIMEOUT_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 15_000;

export function readState(path: string): SupervisorState | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SupervisorState;
  } catch {
    return null;
  }
}

/** Create the state file; fails with EEXIST when another supervisor already has one. */
export function createState(path: string, state: SupervisorState): void {
  writeFileSync(path, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the supervisor a state file describes can still be running: its pid is alive and it
 * started after the last boot (a state file that survived a reboot may name a reused pid).
 */
export function mayBeRunning(state: SupervisorState): boolean {
  const bootedAt = Date.now() - uptime() * 1000;
  return Date.parse(state.startedAt) > bootedAt && isAlive(state.pid);
}

export class SupervisorClient {
  constructor(readonly state: SupervisorState) {}

  status(): Promise<BotStatus> {
    return this.call('GET', '/status', STATUS_TIMEOUT_MS);
  }

  /** Restart the bot now on the checked-out code. */
  restart(): Promise<BotStatus> {
    return this.call('POST', '/restart', OPERATION_TIMEOUT_MS);
  }

  /** Stop the bot and keep it stopped, the supervisor still running. */
  holdBot(): Promise<BotStatus> {
    return this.call('POST', '/bot/stop', OPERATION_TIMEOUT_MS);
  }

  releaseBot(): Promise<BotStatus> {
    return this.call('POST', '/bot/start', OPERATION_TIMEOUT_MS);
  }

  /** Stop the bot, then the supervisor. */
  stop(): Promise<BotStatus> {
    return this.call('POST', '/stop', OPERATION_TIMEOUT_MS);
  }

  private async call(method: string, path: string, timeoutMs: number): Promise<BotStatus> {
    const response = await fetch(`http://127.0.0.1:${this.state.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.state.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`supervisor ${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as BotStatus;
  }
}

/**
 * The running supervisor, or null when there is none. A state file left by one that is gone is
 * removed; one whose process is alive but does not answer is an error, not something to replace.
 */
export async function connectSupervisor(files: SupervisorFiles): Promise<SupervisorClient | null> {
  const state = readState(files.state);
  if (!state) {
    return null;
  }
  if (!mayBeRunning(state)) {
    rmSync(files.state, { force: true });
    return null;
  }
  const client = new SupervisorClient(state);
  try {
    await client.status();
  } catch (error) {
    throw new Error(
      `the supervisor (pid ${state.pid}) does not answer on 127.0.0.1:${state.port}: ${(error as Error).message}`,
    );
  }
  return client;
}

/** Start a supervisor in the background, in a session of its own, and wait until it answers. */
export async function launchSupervisor(app: AppDefinition): Promise<SupervisorClient> {
  mkdirSync(app.files.dir, { recursive: true });
  const output = openSync(app.files.log, 'a');
  const daemon = spawn(process.execPath, [DAEMON], {
    cwd: app.cwd,
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  closeSync(output);
  daemon.unref();
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState(app.files.state);
    if (state && state.pid === daemon.pid) {
      return new SupervisorClient(state);
    }
    if (daemon.exitCode !== null) {
      throw new Error(`the supervisor exited at start (code ${daemon.exitCode}); see ${app.files.log}`);
    }
    await Bun.sleep(100);
  }
  throw new Error(`the supervisor did not come up within ${LAUNCH_TIMEOUT_MS / 1000}s; see ${app.files.log}`);
}

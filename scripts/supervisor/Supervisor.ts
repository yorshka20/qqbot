// Runs the bot as a child process and keeps it running. A bot that exits is started again, at most
// once per restart throttle, so a start that keeps failing does not spin.
//
// The bot runs in a process group of its own, with an IPC channel:
// - a clean stop is a `shutdown` message, the same on every platform (Windows has no SIGTERM);
//   a bot that has not exited by the stop timeout is killed, with its whole process tree;
// - the bot exits by itself when the channel closes, so it never outlives this process;
// - once the bot has exited, whatever is left in its process group is killed (on Windows a tree cannot
//   be found once its root is gone, so this is POSIX-only). A child that leads a group of its own is
//   out of reach here and has to be tied to the bot itself, as the browser is (BrowserService, `pipe`).
//
// Restart, hold-stopped, release and close run one at a time, in the order they were asked for.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import type { BotToSupervisor, SupervisorToBot } from '../../packages/bot/src/utils/supervisorProtocol';
import type { AppDefinition } from './app';

export interface ExitRecord {
  code: number | null;
  signal: string | null;
  at: string;
  uptimeMs: number;
}

export interface BotStatus {
  state: 'running' | 'stopping' | 'waiting' | 'held' | 'stopped';
  pid: number | null;
  startedAt: string | null;
  starts: number;
  lastExit: ExitRecord | null;
  nextStartAt: string | null;
  deploying: boolean;
}

/** How long to wait before starting again a bot that last started at `lastStartAt`. */
export function restartDelay(lastStartAt: number, now: number, throttleMs: number): number {
  return Math.max(0, lastStartAt + throttleMs - now);
}

const isWindows = process.platform === 'win32';

function killTree(pid: number): void {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
}

export class Supervisor {
  private child: ChildProcess | null = null;
  private childStartedAt = 0;
  private stoppingChild: ChildProcess | null = null;
  private starts = 0;
  private lastExit: ExitRecord | null = null;
  private held = false;
  private closed = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private nextStartAt: number | null = null;
  private deploy: ChildProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly app: AppDefinition,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    this.spawnBot();
  }

  status(): BotStatus {
    let state: BotStatus['state'];
    if (this.child) {
      state = this.child === this.stoppingChild ? 'stopping' : 'running';
    } else if (this.held) {
      state = 'held';
    } else {
      state = this.restartTimer ? 'waiting' : 'stopped';
    }
    return {
      state,
      pid: this.child?.pid ?? null,
      startedAt: this.child ? new Date(this.childStartedAt).toISOString() : null,
      starts: this.starts,
      lastExit: this.lastExit,
      nextStartAt: this.nextStartAt === null ? null : new Date(this.nextStartAt).toISOString(),
      deploying: this.deploy !== null,
    };
  }

  /** Stop the bot and start it again at once, throttle or not. */
  restart(): Promise<void> {
    return this.serial(async () => {
      this.cancelRestart();
      this.held = false;
      await this.stopBot();
      this.spawnBot();
    });
  }

  /** Stop the bot and keep it stopped until `release`. */
  hold(): Promise<void> {
    return this.serial(async () => {
      this.held = true;
      this.cancelRestart();
      await this.stopBot();
    });
  }

  /** Start the bot now, ending a hold. */
  release(): Promise<void> {
    return this.serial(async () => {
      this.held = false;
      this.cancelRestart();
      if (!this.child) {
        this.spawnBot();
      }
    });
  }

  /** Stop the bot for good. */
  close(): Promise<void> {
    return this.serial(async () => {
      this.closed = true;
      this.cancelRestart();
      await this.stopBot();
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private spawnBot(): void {
    mkdirSync(this.app.files.dir, { recursive: true });
    const output = openSync(this.app.files.botOutput, 'a');
    const [command, ...args] = this.app.cmd;
    const child = spawn(command, args, {
      cwd: this.app.cwd,
      env: this.app.env,
      detached: true,
      stdio: ['ignore', output, output, 'ipc'],
      windowsHide: true,
    });
    closeSync(output);
    this.child = child;
    this.childStartedAt = Date.now();
    this.starts += 1;
    this.log(`bot started (pid ${child.pid}, start #${this.starts})`);
    child.on('message', (message) => this.onMessage(message as BotToSupervisor));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    // A failed spawn may report only `error`, never `exit`.
    child.on('error', (error) => {
      this.log(`bot process error: ${error.message}`);
      if (child.pid === undefined) {
        this.onExit(child, null, null);
      }
    });
  }

  private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    if (!isWindows && child.pid !== undefined) {
      killTree(child.pid);
    }
    const uptimeMs = Date.now() - this.childStartedAt;
    this.lastExit = { code, signal, at: new Date().toISOString(), uptimeMs };
    this.log(`bot exited (code ${code}, signal ${signal}) after ${Math.round(uptimeMs / 1000)}s`);
    if (child === this.stoppingChild || this.held || this.closed) {
      return;
    }
    const delay = restartDelay(this.childStartedAt, Date.now(), this.app.restartThrottleMs);
    this.nextStartAt = Date.now() + delay;
    this.log(delay > 0 ? `starting it again in ${Math.ceil(delay / 1000)}s` : 'starting it again');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.nextStartAt = null;
      void this.serial(async () => {
        if (!this.child && !this.held && !this.closed) {
          this.spawnBot();
        }
      });
    }, delay);
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.nextStartAt = null;
  }

  private async stopBot(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.stoppingChild = child;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const shutdown: SupervisorToBot = { type: 'shutdown' };
    try {
      child.send(shutdown, (error) => {
        if (error) {
          this.log(`could not ask the bot to shut down: ${error.message}`);
        }
      });
    } catch (error) {
      this.log(`could not ask the bot to shut down: ${(error as Error).message}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.app.stopTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut && child.pid !== undefined) {
      this.log(`bot did not exit within ${this.app.stopTimeoutMs / 1000}s; killing it`);
      killTree(child.pid);
      await exited;
    }
    this.stoppingChild = null;
  }

  private onMessage(message: BotToSupervisor): void {
    if (message.type === 'restart') {
      this.log('the bot asked for a restart');
      void this.restart();
    } else if (message.type === 'deploy') {
      this.log('the bot asked for a deploy');
      this.runDeploy();
    }
  }

  private runDeploy(): void {
    if (this.deploy) {
      this.log(`a deploy is already running (pid ${this.deploy.pid}); request ignored`);
      return;
    }
    const output = openSync(this.app.files.deployLog, 'a');
    const [command, ...args] = this.app.deployCmd;
    const deploy = spawn(command, args, {
      cwd: this.app.cwd,
      stdio: ['ignore', output, output],
      windowsHide: true,
    });
    closeSync(output);
    this.deploy = deploy;
    this.log(`deploy started (pid ${deploy.pid}); output: ${this.app.files.deployLog}`);
    deploy.on('exit', (code) => {
      this.deploy = null;
      this.log(`deploy finished (code ${code})`);
    });
  }
}

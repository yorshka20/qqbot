// The supervisor process. `bun run start` launches it in the background, in a session of its own,
// with its output appended to logs/supervisor/supervisor.log. It runs the bot through Supervisor and
// takes commands on 127.0.0.1 (control.ts); it stops on `bun run stop`, SIGTERM or SIGINT.

import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { BOT_APP } from './app';
import { connectSupervisor, createState } from './client';
import { controlHandler } from './control';
import { Supervisor } from './Supervisor';

const app = BOT_APP;
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

mkdirSync(app.files.dir, { recursive: true });
const running = await connectSupervisor(app.files);
if (running) {
  log(`another supervisor is running (pid ${running.state.pid}); exiting`);
  process.exit(1);
}

const token = randomBytes(24).toString('hex');
const supervisor = new Supervisor(app, log);
let finishing = false;

function finish(): void {
  rmSync(app.files.state, { force: true });
  log('supervisor stopped');
  process.exit(0);
}

async function stop(reason: string): Promise<void> {
  if (finishing) {
    return;
  }
  finishing = true;
  log(`${reason}; stopping the bot`);
  await supervisor.close();
  finish();
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  // A restart or stop answers only once the bot has exited, which can take the whole stop timeout.
  idleTimeout: 120,
  fetch: controlHandler(supervisor, token, () => {
    finishing = true;
    finish();
  }),
});

const port = server.port;
if (port === undefined) {
  throw new Error('the control server has no TCP port');
}
try {
  createState(app.files.state, { pid: process.pid, port, token, startedAt: new Date().toISOString() });
} catch (error) {
  log(`could not claim ${app.files.state} (${(error as Error).message}); another supervisor is starting; exiting`);
  process.exit(1);
}
log(`supervisor started (pid ${process.pid}, control 127.0.0.1:${port})`);
supervisor.start();

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

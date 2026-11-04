// Run an app under its supervisor (Supervisor.ts), the same way on every platform. Nothing is
// installed into the operating system: the supervisor is started by hand, from a terminal, and
// nothing starts it at boot or login. The bot and the cluster daemon each have a supervisor of
// their own, picked with --app (default: bot; `bun run cluster:*` passes `--app cluster`).
//
// Usage: bun run start           start the supervisor, which starts the bot (no-op when running)
//        bun run stop            stop the bot, then the supervisor
//        bun run restart         restart the bot on the checked-out code
//        bun run status          supervisor and bot state
//        bun run logs [-n N]     follow the bot's log file
//        bun run cluster:start | cluster:stop | cluster:restart | cluster:status | cluster:logs

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { botLogsDir, followLatestLog } from '@qqbot/shared';
import { APP_NAMES, type AppDefinition, appByName, BOT_APP } from './app';
import { connectSupervisor, launchSupervisor, type SupervisorClient } from './client';
import { followFile } from './followFile';
import type { BotStatus } from './Supervisor';

export const COMMANDS = ['start', 'stop', 'restart', 'status', 'logs'] as const;
export type SupervisorCommand = (typeof COMMANDS)[number];

const USAGE = `usage: bun run scripts/supervisor/cli.ts [--app <${APP_NAMES.join('|')}>] <${COMMANDS.join('|')}> [--lines N]`;

export class UsageError extends Error {}

const OPTIONS = {
  lines: { type: 'string', short: 'n', default: '50' },
  app: { type: 'string', default: BOT_APP.name },
} as const;

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${USAGE}`);
  }
}

export function parseCliArgs(argv: string[]): { command: SupervisorCommand; lines: number; app: string } {
  const { positionals, values } = parse(argv);
  if (positionals.length !== 1 || !COMMANDS.includes(positionals[0] as SupervisorCommand)) {
    throw new UsageError(USAGE);
  }
  const lines = Number(values.lines);
  if (!Number.isInteger(lines) || lines < 0) {
    throw new UsageError(`--lines takes a whole number, got "${values.lines}"`);
  }
  if (!APP_NAMES.includes(values.app)) {
    throw new UsageError(`--app takes one of ${APP_NAMES.join(', ')}, got "${values.app}"`);
  }
  return { command: positionals[0] as SupervisorCommand, lines, app: values.app };
}

/**
 * On macOS, local network access belongs to the app a process was started from, and only programs
 * run from Terminal or over SSH get it unconditionally (Apple TN3179). A supervisor started from
 * any other app — an IDE's terminal — reaches the LAN only while that app holds the Local Network
 * permission, which an update of the app can take away from processes already running.
 */
export function localNetworkWarning(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin' || env.SSH_CONNECTION || env.__CFBundleIdentifier === 'com.apple.Terminal') {
    return null;
  }
  const origin = env.__CFBundleIdentifier ? `from ${env.__CFBundleIdentifier}` : 'from outside Terminal';
  return [
    `warning: started ${origin}, not Terminal or SSH.`,
    "  The bot's access to hosts on the local network then depends on that app's Local Network",
    '  permission, and can stop when the app updates. Start it from Terminal.app or over SSH.',
  ].join('\n');
}

function duration(ms: number): string {
  let rest = Math.max(0, Math.round(ms / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 || (unit === 's' && parts.length === 0)) {
      parts.push(`${count}${unit}`);
    }
  }
  return parts.slice(0, 2).join(' ');
}

function printStatus(app: AppDefinition, client: SupervisorClient, status: BotStatus): void {
  const { pid, port, startedAt } = client.state;
  const label = app.name.padEnd(11);
  console.log(`supervisor  running (pid ${pid}, since ${startedAt}, control 127.0.0.1:${port})`);
  const up = status.startedAt ? `, up ${duration(Date.now() - Date.parse(status.startedAt))}` : '';
  console.log(`${label} ${status.state}${status.pid ? ` (pid ${status.pid}${up})` : ''}, ${status.starts} start(s)`);
  if (status.lastExit) {
    const { code, signal, at, uptimeMs } = status.lastExit;
    console.log(`last exit   code ${code}, signal ${signal}, after ${duration(uptimeMs)}, at ${at}`);
  }
  if (status.nextStartAt) {
    console.log(`next start  in ${duration(Date.parse(status.nextStartAt) - Date.now())}`);
  }
  if (status.deploying) {
    console.log(`deploy      running; output: ${app.files.deployLog}`);
  }
}

function printTail(path: string, lines: number): void {
  if (!existsSync(path)) {
    return;
  }
  const tail = readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines);
  if (tail.join('').trim()) {
    console.log(`\nlast lines of ${path}:`);
    for (const line of tail) {
      console.log(`  ${line}`);
    }
  }
}

async function start(app: AppDefinition): Promise<void> {
  const running = await connectSupervisor(app.files);
  if (running) {
    console.log('already running');
    printStatus(app, running, await running.status());
    return;
  }
  const warning = localNetworkWarning(process.env, process.platform);
  if (warning) {
    console.warn(warning);
  }
  const client = await launchSupervisor(app);
  printStatus(app, client, await client.status());
  const logs = app === BOT_APP ? 'bun run logs' : `bun run ${app.name}:logs`;
  console.log(`\n${app.name} log: ${logs}    supervisor log: ${app.files.log}`);
}

/** The bot's own logger writes `logs/<date>/`; every other app's log is its captured output. */
async function followLogs(app: AppDefinition, lines: number): Promise<void> {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  if (app === BOT_APP) {
    console.log(`following the newest log file under ${botLogsDir()} (Ctrl+C to stop)`);
    await followLatestLog(botLogsDir(), (line) => console.log(line), { signal: abort.signal, initialLines: lines });
    return;
  }
  console.log(`following ${app.files.botOutput} (Ctrl+C to stop)`);
  await followFile(app.files.botOutput, (line) => console.log(line), { signal: abort.signal, initialLines: lines });
}

async function main(argv: string[]): Promise<void> {
  const { command, lines, app: appName } = parseCliArgs(argv);
  const app = appByName(appName);
  if (command === 'logs') {
    await followLogs(app, lines);
    return;
  }
  if (command === 'start') {
    await start(app);
    return;
  }
  const client = await connectSupervisor(app.files);
  if (command === 'restart' && !client) {
    await start(app);
    return;
  }
  if (!client) {
    const startCommand = app === BOT_APP ? 'bun run start' : `bun run ${app.name}:start`;
    console.log(`the supervisor is not running (start it with \`${startCommand}\`)`);
    printTail(app.files.log, 5);
    return;
  }
  if (command === 'status') {
    printStatus(app, client, await client.status());
    printTail(app.files.botOutput, 5);
  } else if (command === 'restart') {
    printStatus(app, client, await client.restart());
  } else {
    await client.stop();
    while (existsSync(app.files.state)) {
      await Bun.sleep(100);
    }
    console.log(`${app.name} and supervisor stopped`);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : `error: ${(error as Error).message}`);
    process.exit(1);
  }
}

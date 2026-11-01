// Run the bot under its supervisor (Supervisor.ts), the same way on every platform. Nothing is
// installed into the operating system: the supervisor is started by hand, from a terminal, and
// nothing starts it at boot or login.
//
// Usage: bun run start           start the supervisor, which starts the bot (no-op when running)
//        bun run stop            stop the bot, then the supervisor
//        bun run restart         restart the bot on the checked-out code
//        bun run status          supervisor and bot state
//        bun run logs [-n N]     follow the bot's log file

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { botLogsDir, followLatestLog } from '../../packages/bot/src/utils/logFiles';
import { BOT_APP } from './app';
import { connectSupervisor, launchSupervisor, type SupervisorClient } from './client';
import type { BotStatus } from './Supervisor';

export const COMMANDS = ['start', 'stop', 'restart', 'status', 'logs'] as const;
export type SupervisorCommand = (typeof COMMANDS)[number];

const USAGE = `usage: bun run scripts/supervisor/cli.ts <${COMMANDS.join('|')}> [--lines N]`;

export class UsageError extends Error {}

const OPTIONS = { lines: { type: 'string', short: 'n', default: '50' } } as const;

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${USAGE}`);
  }
}

export function parseCliArgs(argv: string[]): { command: SupervisorCommand; lines: number } {
  const { positionals, values } = parse(argv);
  if (positionals.length !== 1 || !COMMANDS.includes(positionals[0] as SupervisorCommand)) {
    throw new UsageError(USAGE);
  }
  const lines = Number(values.lines);
  if (!Number.isInteger(lines) || lines < 0) {
    throw new UsageError(`--lines takes a whole number, got "${values.lines}"`);
  }
  return { command: positionals[0] as SupervisorCommand, lines };
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

function printStatus(client: SupervisorClient, bot: BotStatus): void {
  const { pid, port, startedAt } = client.state;
  console.log(`supervisor  running (pid ${pid}, since ${startedAt}, control 127.0.0.1:${port})`);
  const up = bot.startedAt ? `, up ${duration(Date.now() - Date.parse(bot.startedAt))}` : '';
  console.log(`bot         ${bot.state}${bot.pid ? ` (pid ${bot.pid}${up})` : ''}, ${bot.starts} start(s)`);
  if (bot.lastExit) {
    const { code, signal, at, uptimeMs } = bot.lastExit;
    console.log(`last exit   code ${code}, signal ${signal}, after ${duration(uptimeMs)}, at ${at}`);
  }
  if (bot.nextStartAt) {
    console.log(`next start  in ${duration(Date.parse(bot.nextStartAt) - Date.now())}`);
  }
  if (bot.deploying) {
    console.log(`deploy      running; output: ${BOT_APP.files.deployLog}`);
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

async function start(): Promise<void> {
  const running = await connectSupervisor(BOT_APP.files);
  if (running) {
    console.log('already running');
    printStatus(running, await running.status());
    return;
  }
  const warning = localNetworkWarning(process.env, process.platform);
  if (warning) {
    console.warn(warning);
  }
  const client = await launchSupervisor(BOT_APP);
  printStatus(client, await client.status());
  console.log(`\nbot log: bun run logs    supervisor log: ${BOT_APP.files.log}`);
}

async function main(argv: string[]): Promise<void> {
  const { command, lines } = parseCliArgs(argv);
  if (command === 'logs') {
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    console.log(`following the newest log file under ${botLogsDir()} (Ctrl+C to stop)`);
    await followLatestLog(botLogsDir(), (line) => console.log(line), { signal: abort.signal, initialLines: lines });
    return;
  }
  if (command === 'start') {
    await start();
    return;
  }
  const client = await connectSupervisor(BOT_APP.files);
  if (command === 'restart' && !client) {
    await start();
    return;
  }
  if (!client) {
    console.log('the supervisor is not running (start it with `bun run start`)');
    printTail(BOT_APP.files.log, 5);
    return;
  }
  if (command === 'status') {
    printStatus(client, await client.status());
    printTail(BOT_APP.files.botOutput, 5);
  } else if (command === 'restart') {
    printStatus(client, await client.restart());
  } else {
    await client.stop();
    while (existsSync(BOT_APP.files.state)) {
      await Bun.sleep(100);
    }
    console.log('bot and supervisor stopped');
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

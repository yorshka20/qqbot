// WebUI local-client manager. The WebUI is a local web client, not a service: it runs in the
// background so that it outlives the terminal that started it, but nothing restarts it.
//
// Usage: bun run ui:start | ui:stop | ui:restart | ui:status
//
// `bun run --filter @qqbot/webui dev` is a process tree (bun → vite → esbuild), and killing only its
// root would orphan vite and esbuild. On POSIX the tree runs in a process group of its own
// (`detached`), so stop signals the whole group; on Windows `taskkill /T` ends the tree.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { botLogsDir } from '../packages/bot/src/utils/logFiles';
import { getRepoRoot } from '../packages/bot/src/utils/repoRoot';

const PID_FILE = join(botLogsDir(), 'webui.pid');
const LOG_FILE = join(botLogsDir(), 'webui.log');
const STOP_TIMEOUT_MS = 5000;
const isWindows = process.platform === 'win32';

/** Signal the WebUI's tree, or with signal 0 test whether any of it is still alive. */
function signalTree(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(isWindows ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}

function runningPid(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 && signalTree(pid, 0) ? pid : null;
}

function start(): void {
  const running = runningPid();
  if (running) {
    console.log(`WebUI already running (pid ${running}). Logs: ${LOG_FILE}`);
    return;
  }
  mkdirSync(botLogsDir(), { recursive: true });
  const output = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['run', '--filter', '@qqbot/webui', 'dev'], {
    cwd: getRepoRoot(),
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  closeSync(output);
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`WebUI started (pid ${child.pid}). Logs: ${LOG_FILE}`);
}

function stop(): void {
  const pid = runningPid();
  if (!pid) {
    console.log('WebUI not running.');
    rmSync(PID_FILE, { force: true });
    return;
  }
  if (isWindows) {
    // Windows has no SIGTERM for a console process tree; taskkill /T /F is the way to end one.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    signalTree(pid, 'SIGTERM');
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (signalTree(pid, 0) && Date.now() < deadline) {
      Bun.sleepSync(200);
    }
    signalTree(pid, 'SIGKILL');
  }
  rmSync(PID_FILE, { force: true });
  console.log('WebUI stopped.');
}

function status(): void {
  const pid = runningPid();
  console.log(pid ? `WebUI running (pid ${pid}). Logs: ${LOG_FILE}` : 'WebUI not running.');
}

const commands: Record<string, () => void> = {
  start,
  stop,
  restart: () => {
    stop();
    start();
  },
  status,
};

const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error(`Usage: bun run scripts/ui.ts <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
command();

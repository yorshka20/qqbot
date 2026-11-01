// The bot's side of its supervisor (scripts/supervisor), reached over the IPC channel the
// supervisor spawns it with. A bot started any other way (`bun run bot`, `bun run dev`) has no
// supervisor: nothing would start it again, so it cannot restart or deploy itself.

import { botLogsDir } from '@/utils/logFiles';
import { getRepoRoot } from '@/utils/repoRoot';
import {
  type BotToSupervisor,
  SUPERVISED_ENV,
  type SupervisorToBot,
  supervisorFiles,
} from '@/utils/supervisorProtocol';

/** How long a restart or deploy request waits, so the reply announcing it goes out first. */
const REPLY_GRACE_MS = 2000;

export function isSupervised(): boolean {
  return process.env[SUPERVISED_ENV] === '1';
}

/**
 * Shut down when the supervisor asks, and when it goes away: a bot never outlives its supervisor,
 * so a supervisor started later never finds one already running.
 */
export function followSupervisor(shutdown: (reason: string) => void): void {
  if (!isSupervised()) {
    return;
  }
  process.on('message', (message: SupervisorToBot) => {
    if (message.type === 'shutdown') {
      shutdown('Supervisor asked for shutdown');
    }
  });
  process.on('disconnect', () => shutdown('Supervisor is gone'));
}

function sendLater(message: BotToSupervisor): void {
  if (!isSupervised() || !process.send) {
    throw new Error('not running under the supervisor');
  }
  const send = process.send.bind(process);
  setTimeout(() => send(message), REPLY_GRACE_MS);
}

/** Restart on the code already checked out. */
export function requestRestart(): void {
  sendLater({ type: 'restart' });
}

/** `bun run deploy`, run by the supervisor; returns the file its output goes to. */
export function requestDeploy(): string {
  sendLater({ type: 'deploy' });
  return supervisorFiles(botLogsDir()).deployLog;
}

export interface DeployCheck {
  ok: boolean;
  report: string;
}

/** What `bun run deploy` would do, or why it would refuse (`bun run deploy --check`). */
export async function checkDeploy(): Promise<DeployCheck> {
  const proc = Bun.spawn([process.execPath, 'run', 'deploy', '--check'], {
    cwd: getRepoRoot(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, report: `${stdout}${stderr}`.trim() };
}

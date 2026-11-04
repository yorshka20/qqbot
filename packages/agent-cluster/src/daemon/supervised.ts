/**
 * The daemon's side of `scripts/supervisor`, which spawns it with an IPC channel and sets
 * `QQBOT_SUPERVISED`. A clean stop is a `{ type: 'shutdown' }` message, the same on every
 * platform (Windows has no SIGTERM), and a daemon never outlives its supervisor: otherwise the
 * next `cluster:start` would find the state directory locked by an orphan.
 *
 * The names mirror `packages/bot/src/utils/supervisorProtocol.ts`; a package never imports the
 * bot, so they are spelled out here.
 */

const SUPERVISED_ENV = 'QQBOT_SUPERVISED';

export function isSupervised(): boolean {
  return process.env[SUPERVISED_ENV] === '1';
}

export function followSupervisor(shutdown: (reason: string) => void): void {
  if (!isSupervised()) {
    return;
  }
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'shutdown') {
      shutdown('Supervisor asked for shutdown');
    }
  });
  process.on('disconnect', () => shutdown('Supervisor is gone'));
}

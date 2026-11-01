// What the supervisor (scripts/supervisor) and the bot it runs say to each other. The supervisor
// spawns the bot with an IPC channel and sets SUPERVISED_ENV; the messages travel over that channel.
// Nothing here has side effects on import, so the supervisor can share it.

import { join } from 'node:path';

export const SUPERVISED_ENV = 'QQBOT_SUPERVISED';

export interface SupervisorFiles {
  dir: string;
  state: string;
  log: string;
  botOutput: string;
  deployLog: string;
}

/** The supervisor's files, kept under the bot's logs directory. */
export function supervisorFiles(logsDir: string): SupervisorFiles {
  const dir = join(logsDir, 'supervisor');
  return {
    dir,
    state: join(dir, 'state.json'),
    log: join(dir, 'supervisor.log'),
    botOutput: join(dir, 'bot-output.log'),
    deployLog: join(dir, 'deploy.log'),
  };
}

/** The bot asks for a restart on the checked-out code, or for `bun run deploy`. */
export type BotToSupervisor = { type: 'restart' } | { type: 'deploy' };

/** The supervisor asks the bot to shut down cleanly; it is killed if it has not exited in time. */
export type SupervisorToBot = { type: 'shutdown' };

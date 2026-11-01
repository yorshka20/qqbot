// What the supervisor runs: the bot, from the repo root, with the environment of the terminal that
// started the supervisor.

import { join } from 'node:path';
import { botLogsDir } from '../../packages/bot/src/utils/logFiles';
import { getRepoRoot } from '../../packages/bot/src/utils/repoRoot';
import { SUPERVISED_ENV, type SupervisorFiles, supervisorFiles } from '../../packages/bot/src/utils/supervisorProtocol';

export interface AppDefinition {
  name: string;
  cmd: string[];
  deployCmd: string[];
  cwd: string;
  env: Record<string, string>;
  restartThrottleMs: number;
  stopTimeoutMs: number;
  files: SupervisorFiles;
}

export function defineBotApp(
  root: string,
  bun: string,
  shellEnv: NodeJS.ProcessEnv,
  files: SupervisorFiles,
): AppDefinition {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined) {
      inherited[key] = value;
    }
  }
  return {
    name: 'qq-bot',
    cmd: [bun, 'packages/bot/src/index.ts'],
    deployCmd: [bun, join(root, 'scripts', 'deploy.ts')],
    cwd: root,
    // The bot's log files hold every entry; stdout is only an unrotated capture of what the logger
    // does not write (output from before it is up, a runtime crash, a dependency printing itself).
    env: { LOG_LEVEL: 'info', NODE_ENV: 'development', ...inherited, NO_CONSOLE_LOG: '1', [SUPERVISED_ENV]: '1' },
    // A start that keeps failing (LLBot not up yet, say) is retried once a minute.
    restartThrottleMs: 60_000,
    stopTimeoutMs: 10_000,
    files,
  };
}

export const BOT_APP = defineBotApp(getRepoRoot(), process.execPath, process.env, supervisorFiles(botLogsDir()));

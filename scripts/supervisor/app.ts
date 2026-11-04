// What the supervisor runs, from the repo root, with the environment of the terminal that started
// the supervisor: the bot, and the cluster daemon. Each app has a supervisor of its own, with its
// own state file and logs, so `bun run restart` and `bun run cluster:restart` never touch each
// other's process.

import { join } from 'node:path';
import { botLogsDir, getRepoRoot } from '@qqbot/shared';
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

function inheritedEnv(shellEnv: NodeJS.ProcessEnv): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined) {
      inherited[key] = value;
    }
  }
  return inherited;
}

export function defineBotApp(
  root: string,
  bun: string,
  shellEnv: NodeJS.ProcessEnv,
  files: SupervisorFiles,
): AppDefinition {
  return {
    name: 'bot',
    cmd: [bun, 'packages/bot/src/index.ts'],
    deployCmd: [bun, join(root, 'scripts', 'deploy.ts')],
    cwd: root,
    // The bot's log files hold every entry; stdout is only an unrotated capture of what the logger
    // does not write (output from before it is up, a runtime crash, a dependency printing itself).
    env: {
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
      ...inheritedEnv(shellEnv),
      NO_CONSOLE_LOG: '1',
      [SUPERVISED_ENV]: '1',
    },
    // A start that keeps failing (LLBot not up yet, say) is retried once a minute.
    restartThrottleMs: 60_000,
    stopTimeoutMs: 10_000,
    files,
  };
}

/**
 * The cluster daemon. Its stdout is kept in full (no NO_CONSOLE_LOG), so the supervisor's
 * output capture is its log and `bun run cluster:logs` follows that file. Stopping it only has
 * to flush its store — the workers it launched are detached and outlive it — so the stop timeout
 * is generous but a kill loses nothing but the flush.
 */
export function defineClusterApp(
  root: string,
  bun: string,
  shellEnv: NodeJS.ProcessEnv,
  files: SupervisorFiles,
): AppDefinition {
  return {
    name: 'cluster',
    cmd: [bun, 'packages/agent-cluster/src/daemon/main.ts'],
    deployCmd: [bun, join(root, 'scripts', 'deploy.ts')],
    cwd: root,
    env: {
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
      ...inheritedEnv(shellEnv),
      QQBOT_LOGS_DIR: files.dir.replace(/[\\/]supervisor$/, ''),
      [SUPERVISED_ENV]: '1',
    },
    restartThrottleMs: 60_000,
    stopTimeoutMs: 30_000,
    files,
  };
}

export const BOT_APP = defineBotApp(getRepoRoot(), process.execPath, process.env, supervisorFiles(botLogsDir()));
export const CLUSTER_APP = defineClusterApp(
  getRepoRoot(),
  process.execPath,
  process.env,
  supervisorFiles(join(botLogsDir(), 'cluster')),
);

export const APPS: readonly AppDefinition[] = [BOT_APP, CLUSTER_APP];
export const APP_NAMES = APPS.map((app) => app.name);

export function appByName(name: string): AppDefinition {
  const app = APPS.find((candidate) => candidate.name === name);
  if (!app) {
    throw new Error(`unknown app "${name}"; one of ${APP_NAMES.join(', ')}`);
  }
  return app;
}

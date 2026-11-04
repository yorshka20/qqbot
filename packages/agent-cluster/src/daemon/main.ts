// Entry point of the cluster daemon: `bun run packages/agent-cluster/src/daemon/main.ts`.
// Reads the shared config tree (`$CONFIG_PATH`, else `config.d/`, else `config.jsonc`) and runs until
// its supervisor asks it to stop, or SIGTERM / SIGINT.

import 'reflect-metadata';

import { logger } from '@qqbot/shared';
import { ProjectRegistry } from '../codingAgent/ProjectRegistry';
import { ClusterDaemon } from './ClusterDaemon';
import { defaultClusterDaemonConfigPath, loadClusterDaemonConfig } from './config';
import { followSupervisor } from './supervised';

async function main(): Promise<void> {
  const configPath = defaultClusterDaemonConfigPath();
  const config = loadClusterDaemonConfig(configPath);
  logger.info(`[ClusterDaemon] Config ${configPath}`);

  const daemon = new ClusterDaemon(config, new ProjectRegistry(config.projectRegistry));

  let stopping: Promise<void> | null = null;
  const shutdown = (reason: string): void => {
    if (stopping) {
      return;
    }
    logger.info(`[ClusterDaemon] ${reason}; stopping`);
    stopping = daemon
      .stop()
      .catch((err) => logger.error('[ClusterDaemon] Stop failed:', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM received'));
  process.on('SIGINT', () => shutdown('SIGINT received'));
  followSupervisor(shutdown);

  await daemon.start();
}

main().catch((err) => {
  logger.error('[ClusterDaemon] Failed to start:', err);
  process.exit(1);
});

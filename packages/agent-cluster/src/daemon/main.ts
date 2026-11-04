// Entry point of the cluster daemon: `bun run packages/agent-cluster/src/daemon/main.ts`.
// Reads `cluster.jsonc` (or `$CLUSTER_CONFIG_PATH`), runs until SIGTERM / SIGINT.

import 'reflect-metadata';

import { logger } from '@qqbot/shared';
import { ProjectRegistry } from '../codingAgent/ProjectRegistry';
import { ClusterDaemon } from './ClusterDaemon';
import { defaultClusterDaemonConfigPath, loadClusterDaemonConfig } from './config';

async function main(): Promise<void> {
  const configPath = defaultClusterDaemonConfigPath();
  const config = loadClusterDaemonConfig(configPath);
  logger.info(`[ClusterDaemon] Config ${configPath}`);

  const daemon = new ClusterDaemon(config, new ProjectRegistry(config.projectRegistry));

  let stopping: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    logger.info(`[ClusterDaemon] ${signal} received`);
    stopping = daemon
      .stop()
      .catch((err) => logger.error('[ClusterDaemon] Stop failed:', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await daemon.start();
}

main().catch((err) => {
  logger.error('[ClusterDaemon] Failed to start:', err);
  process.exit(1);
});

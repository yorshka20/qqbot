// Main entry point
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import { type App, startApp } from './core/app';
import { followSupervisor } from './core/supervisor';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting bot...');

  // ── Graceful shutdown ──
  // Wired before startup, so a stop that arrives while the bot is still connecting is not lost.
  let app: App | null = null;
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[Main] ${reason}, shutting down...`);
    await app?.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('Received SIGINT'));
  process.on('SIGTERM', () => shutdown('Received SIGTERM'));
  followSupervisor(shutdown);

  try {
    app = await startApp(process.env.CONFIG_PATH, { connect: true });
    logger.info('[Main] Bot initialized and ready');
  } catch (error) {
    logger.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('[Main] Unhandled error:', error);
  process.exit(1);
});

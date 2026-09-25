// Main entry point
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import { startApp } from './core/app';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting bot...');

  try {
    const app = await startApp(process.env.CONFIG_PATH, { connect: true });
    logger.info('[Main] Bot initialized and ready');

    // ── Graceful shutdown ──
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`[Main] Received ${signal}, shutting down...`);
      await app.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    logger.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('[Main] Unhandled error:', error);
  process.exit(1);
});

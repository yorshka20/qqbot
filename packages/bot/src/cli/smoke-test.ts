// Smoke test — boots the app through the SAME startApp() as src/index.ts, without the
// live connections, to catch DI / circular-import / initialization-order issues that
// typecheck misses. Plugins are enabled exactly as configured; after a settle window
// that surfaces asynchronous startup failures, the real shutdown sequence runs.
//
// Usage: bun run src/cli/smoke-test.ts [--timeout 30000] [--settle 2000]
// Exit 0 = success, 1 = failure

import 'reflect-metadata';

import { startApp } from '@/core/app';
import { logger } from '@/utils/logger';

function numberArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? Number(process.argv[idx + 1]) || fallback : fallback;
}

const timeoutMs = numberArg('--timeout', 30_000);
const settleMs = numberArg('--settle', 2_000);

const timer = setTimeout(() => {
  logger.error('[SmokeTest] Timed out after', timeoutMs, 'ms');
  process.exit(1);
}, timeoutMs);

// Fire-and-forget work started during bootstrap (health checks, warmups, plugin enables)
// rejects after bootstrapApp() has already resolved; only a listener catches those.
const asyncFailures: unknown[] = [];
process.on('unhandledRejection', (reason) => {
  asyncFailures.push(reason);
});

async function smokeTest() {
  logger.info('[SmokeTest] Starting initialization smoke test...');

  const app = await startApp(process.env.CONFIG_PATH, { connect: false });

  await new Promise((resolve) => setTimeout(resolve, settleMs));
  if (asyncFailures.length > 0) {
    for (const failure of asyncFailures) {
      logger.error('[SmokeTest] Unhandled rejection after bootstrap:', failure);
    }
    throw new Error(`${asyncFailures.length} unhandled rejection(s) within ${settleMs}ms of bootstrap`);
  }

  await app.shutdown();

  logger.info('[SmokeTest] ✅ Smoke test passed — initialization and shutdown completed successfully');
}

smokeTest()
  .then(() => {
    clearTimeout(timer);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timer);
    logger.error('[SmokeTest] ✗ FAILED:', err);
    process.exit(1);
  });

// Smoke test — calls the SAME bootstrapApp() as src/index.ts to catch
// DI / circular-import / initialization-order issues that typecheck misses.
//
// Usage: bun run src/cli/smoke-test.ts [--timeout 15000]
// Exit 0 = success, 1 = failure

import 'reflect-metadata';

import { bootstrapApp } from '@/core/bootstrap';
import { stopStaticFileServer } from '@/services/staticServer';
import { logger } from '@/utils/logger';

const timeoutMs = (() => {
  const idx = process.argv.indexOf('--timeout');
  return idx >= 0 ? Number(process.argv[idx + 1]) || 15_000 : 15_000;
})();

const timer = setTimeout(() => {
  logger.error('[SmokeTest] Timed out after', timeoutMs, 'ms');
  process.exit(1);
}, timeoutMs);

async function smokeTest() {
  logger.info('[SmokeTest] Starting initialization smoke test...');

  const configPath = process.env.CONFIG_PATH;
  const { conversationComponents } = await bootstrapApp(configPath, { skipPluginEnable: true });

  // ── Cleanup ──
  stopStaticFileServer();
  await conversationComponents.databaseManager.close();

  logger.info('[SmokeTest] ✅ Smoke test passed — all initialization stages completed successfully');
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

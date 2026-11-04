// `bun run cluster:gc [--dry-run]`: remove worktrees under `<stateDir>/work` that no pool entry
// claims. Safe beside a running daemon: a leased slot, or one within a project's pool, is claimed.

import 'reflect-metadata';

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@qqbot/shared';
import { createClusterTables } from '../cluster/schema';
import { WorktreePool } from '../cluster/workspace/WorktreePool';
import { ProjectRegistry } from '../codingAgent/ProjectRegistry';
import { defaultClusterDaemonConfigPath, loadClusterDaemonConfig } from './config';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadClusterDaemonConfig(defaultClusterDaemonConfigPath());
  mkdirSync(config.stateDir, { recursive: true });

  const db = new Database(join(config.stateDir, 'state.sqlite'), { create: true });
  db.run('PRAGMA busy_timeout = 5000');
  createClusterTables(db);
  try {
    const pool = new WorktreePool(config.cluster, db, new ProjectRegistry(config.projectRegistry));
    const removed = await pool.gc({ dryRun });
    for (const path of removed) {
      logger.info(`[cluster:gc] ${dryRun ? 'Would remove' : 'Removed'} ${path}`);
    }
    logger.info(`[cluster:gc] ${removed.length} worktree(s) ${dryRun ? 'unclaimed' : 'removed'}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error('[cluster:gc] Failed:', err);
  process.exit(1);
});

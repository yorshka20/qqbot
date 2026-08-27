// LogArchivePlugin - archives old log directories every N days into compressed tar.gz files

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScheduledTask } from 'node-cron';
import { schedule } from 'node-cron';
import { archiveDateDirs } from '@/utils/dateDirArchive';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface LogArchivePluginConfig {
  /** How many days of logs to bundle into one archive (default: 3) */
  intervalDays?: number;
  /** Cron expression for when to run the archive check (default: "0 3 * * *" = daily at 03:00) */
  cron?: string;
  /** Timezone for the cron job (default: "Asia/Tokyo") */
  timezone?: string;
  /** Whether to delete original log directories after successful archival (default: true) */
  deleteAfterArchive?: boolean;
}

const CLAUDE_BACKUP_REL_DIRS = ['.claude-learnings', '.claude-workbook'] as const;

@RegisterPlugin({
  name: 'logArchive',
  version: '1.0.0',
  description:
    'Periodically archives old log directories into tar.gz in logs/archive/; also backs up .claude-learnings and .claude-workbook to data/backup/claude/ (compress only, sources kept).',
})
export class LogArchivePlugin extends PluginBase {
  private cronJob: ScheduledTask | null = null;
  private repoRoot = getRepoRoot();
  private logsDir = join(this.repoRoot, 'logs');
  private archiveDir = join(this.repoRoot, 'logs', 'archive');
  private claudeBackupDir = join(this.repoRoot, 'data', 'backup', 'claude');
  private intervalDays = 3;
  private deleteAfterArchive = true;

  async onInit(): Promise<void> {
    const config = (this.pluginConfig?.config ?? {}) as LogArchivePluginConfig;
    this.intervalDays = config.intervalDays ?? 3;
    this.deleteAfterArchive = config.deleteAfterArchive ?? true;
    const cron = config.cron ?? '0 3 * * *';
    const timezone = config.timezone ?? 'Asia/Tokyo';

    if (!existsSync(this.archiveDir)) {
      mkdirSync(this.archiveDir, { recursive: true });
    }
    if (!existsSync(this.claudeBackupDir)) {
      mkdirSync(this.claudeBackupDir, { recursive: true });
    }

    // Run once on startup
    await this.archiveLogs();
    try {
      await this.archiveClaudeDirs();
    } catch (err) {
      logger.error('[LogArchivePlugin] Claude dirs backup error (startup):', err);
    }

    // Schedule periodic runs
    this.cronJob = schedule(
      cron,
      async () => {
        try {
          await this.archiveLogs();
        } catch (err) {
          logger.error('[LogArchivePlugin] Archive cron error:', err);
        }
        try {
          await this.archiveClaudeDirs();
        } catch (err) {
          logger.error('[LogArchivePlugin] Claude dirs backup cron error:', err);
        }
      },
      { scheduled: true, timezone },
    );

    logger.info(
      `[LogArchivePlugin] Initialized (cron: ${cron}, interval: ${this.intervalDays}d, timezone: ${timezone}, claude dirs: ${CLAUDE_BACKUP_REL_DIRS.join(', ')})`,
    );
  }

  async onDisable(): Promise<void> {
    super.onDisable();
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    logger.info('[LogArchivePlugin] Cron job stopped');
  }

  /**
   * Scan logs/ for date directories older than intervalDays and archive them in batches.
   */
  private async archiveLogs(): Promise<void> {
    await archiveDateDirs({
      sourceDir: this.logsDir,
      archiveDir: this.archiveDir,
      retainDays: this.intervalDays,
      batchDays: this.intervalDays,
      format: 'tar.gz',
      deleteAfterArchive: this.deleteAfterArchive,
      logLabel: '[LogArchivePlugin]',
    });
  }

  /**
   * Compress .claude-learnings and .claude-workbook into data/backup/claude/ (one snapshot per calendar day).
   * Source directories are never removed.
   */
  private async archiveClaudeDirs(): Promise<void> {
    const existing: string[] = [];
    for (const rel of CLAUDE_BACKUP_REL_DIRS) {
      const full = join(this.repoRoot, rel);
      try {
        if (existsSync(full) && statSync(full).isDirectory()) {
          existing.push(rel);
        }
      } catch {
        // ignore stat errors
      }
    }
    if (existing.length === 0) {
      logger.debug(
        '[LogArchivePlugin] No .claude-learnings / .claude-workbook directories present; skip claude backup',
      );
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const archiveName = `claude-dirs-${y}-${m}-${d}`;
    const archivePath = join(this.claudeBackupDir, `${archiveName}.tar.gz`);

    if (existsSync(archivePath)) {
      logger.debug(`[LogArchivePlugin] Claude dirs backup already exists: ${archiveName}.tar.gz`);
      return;
    }

    await this.createArchiveAtRoot(archivePath, existing);
    logger.info(`[LogArchivePlugin] Backed up [${existing.join(', ')}] -> ${archiveName}.tar.gz (sources kept)`);
  }

  /**
   * Create a tar.gz from paths relative to the repo root (e.g. .claude-learnings)
   */
  private async createArchiveAtRoot(archivePath: string, relPaths: string[]): Promise<void> {
    const proc = Bun.spawn(['tar', '-czf', archivePath, ...relPaths], {
      cwd: this.repoRoot,
      stdout: 'ignore',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar failed (exit ${exitCode}): ${stderr}`);
    }
  }
}

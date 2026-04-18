// LogArchivePlugin - archives old log directories every N days into compressed tar.gz files

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScheduledTask } from 'node-cron';
import { schedule } from 'node-cron';
import { logger } from '@/utils/logger';
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

@RegisterPlugin({
  name: 'logArchive',
  version: '1.0.0',
  description: 'Periodically archives old log directories into compressed tar.gz files in logs/archive/',
})
export class LogArchivePlugin extends PluginBase {
  private cronJob: ScheduledTask | null = null;
  private logsDir = join(process.cwd(), 'logs');
  private archiveDir = join(process.cwd(), 'logs', 'archive');
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

    // Run once on startup
    await this.archiveLogs();

    // Schedule periodic runs
    this.cronJob = schedule(
      cron,
      async () => {
        try {
          await this.archiveLogs();
        } catch (err) {
          logger.error('[LogArchivePlugin] Archive cron error:', err);
        }
      },
      { scheduled: true, timezone },
    );

    logger.info(
      `[LogArchivePlugin] Initialized (cron: ${cron}, interval: ${this.intervalDays}d, timezone: ${timezone})`,
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Collect all date directories (YYYY-MM-DD format)
    const dateDirs = this.getDateDirectories();
    if (dateDirs.length === 0) return;

    // Filter directories older than intervalDays (don't archive today or recent days)
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - this.intervalDays);

    const eligibleDirs = dateDirs.filter((d) => d.date < cutoff);
    if (eligibleDirs.length === 0) {
      logger.debug('[LogArchivePlugin] No log directories old enough to archive');
      return;
    }

    // Sort by date ascending
    eligibleDirs.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Group into batches of intervalDays
    for (let i = 0; i < eligibleDirs.length; i += this.intervalDays) {
      const batch = eligibleDirs.slice(i, i + this.intervalDays);
      if (batch.length === 0) continue;

      const startDate = batch[0].date;
      const endDate = batch[batch.length - 1].date;
      const archiveName = this.formatArchiveName(startDate, endDate);
      const archivePath = join(this.archiveDir, `${archiveName}.tar.gz`);

      // Skip if already archived
      if (existsSync(archivePath)) {
        logger.debug(`[LogArchivePlugin] Archive already exists: ${archiveName}.tar.gz`);
        if (this.deleteAfterArchive) {
          for (const dir of batch) {
            this.removeDir(dir.dirName);
          }
        }
        continue;
      }

      await this.createArchive(
        archivePath,
        batch.map((d) => d.dirName),
      );

      if (this.deleteAfterArchive) {
        for (const dir of batch) {
          this.removeDir(dir.dirName);
        }
      }

      logger.info(`[LogArchivePlugin] Archived ${batch.length} day(s) -> ${archiveName}.tar.gz`);
    }
  }

  /**
   * Get all YYYY-MM-DD date directories under logs/
   */
  private getDateDirectories(): Array<{ dirName: string; date: Date }> {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const entries = readdirSync(this.logsDir);
    const result: Array<{ dirName: string; date: Date }> = [];

    for (const entry of entries) {
      if (!datePattern.test(entry)) continue;
      const fullPath = join(this.logsDir, entry);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const [year, month, day] = entry.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      result.push({ dirName: entry, date });
    }

    return result;
  }

  /**
   * Format archive name: YYYY-MMDD-MMDD
   */
  private formatArchiveName(start: Date, end: Date): string {
    const year = start.getFullYear();
    const startMM = String(start.getMonth() + 1).padStart(2, '0');
    const startDD = String(start.getDate()).padStart(2, '0');
    const endMM = String(end.getMonth() + 1).padStart(2, '0');
    const endDD = String(end.getDate()).padStart(2, '0');
    return `${year}-${startMM}${startDD}-${endMM}${endDD}`;
  }

  /**
   * Create a tar.gz archive containing the specified directories
   */
  private async createArchive(archivePath: string, dirNames: string[]): Promise<void> {
    const proc = Bun.spawn(['tar', '-czf', archivePath, ...dirNames], {
      cwd: this.logsDir,
      stdout: 'ignore',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar failed (exit ${exitCode}): ${stderr}`);
    }
  }

  /**
   * Remove a date directory under logs/
   */
  private removeDir(dirName: string): void {
    const fullPath = join(this.logsDir, dirName);
    try {
      rmSync(fullPath, { recursive: true, force: true });
      logger.debug(`[LogArchivePlugin] Removed directory: ${dirName}`);
    } catch (err) {
      logger.warn(`[LogArchivePlugin] Failed to remove directory ${dirName}:`, err);
    }
  }
}

// Memory Plugin - daily memory extraction as a group_day fan-out task, backfills on request,
// memory backups, the daily review of due facts, and the timer that drives the memory batch queue.

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getRepoRoot, logger, resolveFromRepoRoot } from '@qqbot/shared';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { GroupDayFanout } from '@/fanout/contexts/groupDay/GroupDayFanout';
import { MemoryBatchQueue, type MemoryJobHandle } from '@/memory/batch/MemoryBatchQueue';
import { chunkLines } from '@/memory/extraction/chunkLines';
import { GroupDayMemoryTask } from '@/memory/extraction/GroupDayMemoryTask';
import { MemoryExtractService } from '@/memory/extraction/MemoryExtractService';
import { MemoryReviewService } from '@/memory/review/MemoryReviewService';
import { MemoryFactStore } from '@/memory/storage/MemoryFactStore';
import { MemoryIndexSync } from '@/memory/storage/MemoryIndexSync';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface MemoryPluginConfig {
  /** Backfill extracts: max character length per extract chunk. Default 15000. */
  fullHistoryMaxLength?: number;
  /** Backup interval in ms. Default 604800000 (7 days). Set to 0 to disable. */
  backupIntervalMs?: number;
  /** Backup directory path (relative to cwd). Default "data/backup/memory". */
  backupDir?: string;
}

const DEFAULT_FULL_HISTORY_MAX_LENGTH = 15_000;
const DEFAULT_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_BACKUP_DIR = 'data/backup/memory';
const MEMORY_DIR = 'data/memory';
const BATCH_TICK_INTERVAL_MS = 60_000;

@RegisterPlugin({
  name: 'memory',
  version: '1.0.0',
  description: 'Memory: daily extract on the group_day prefix, backfills, review, backups, the memory batch queue',
})
export class MemoryPlugin extends PluginBase {
  /** Backfill extracts: max character length per extract chunk. */
  private fullHistoryMaxLength = DEFAULT_FULL_HISTORY_MAX_LENGTH;

  /** Backup interval timer. */
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private backupIntervalMs = DEFAULT_BACKUP_INTERVAL_MS;
  private backupDir = DEFAULT_BACKUP_DIR;

  /** In-memory guard: backfills currently running; avoid duplicate runs. */
  private fullHistoryPendingKeys = new Set<string>();
  private conversationHistoryService!: ConversationHistoryService;
  private memoryExtractService!: MemoryExtractService;
  private batchQueue!: MemoryBatchQueue;
  private botSelfId = '';

  async onInit(): Promise<void> {
    this.enabled = true;

    const container = getContainer();
    this.conversationHistoryService = container.resolve<ConversationHistoryService>(ConversationHistoryService);
    this.memoryExtractService = container.resolve(MemoryExtractService);
    this.batchQueue = container.resolve(MemoryBatchQueue);

    const config = container.resolve<Config>(DITokens.CONFIG);
    this.botSelfId = config.getConfig().bot.selfId;

    const pluginConfig = this.pluginConfig?.config as MemoryPluginConfig | undefined;
    if (pluginConfig) {
      this.fullHistoryMaxLength = pluginConfig.fullHistoryMaxLength ?? DEFAULT_FULL_HISTORY_MAX_LENGTH;
      this.backupIntervalMs = pluginConfig.backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
      this.backupDir = pluginConfig.backupDir ?? DEFAULT_BACKUP_DIR;
    }
  }

  onStart(): void {
    // Start periodic memory backup
    if (this.backupIntervalMs > 0) {
      // Run an initial backup on startup, then schedule periodic backups
      void this.backupMemoryFiles();
      this.backupTimer = setInterval(() => {
        void this.backupMemoryFiles();
      }, this.backupIntervalMs);
      logger.info(
        `[MemoryPlugin] Memory backup scheduled every ${(this.backupIntervalMs / 3600000).toFixed(1)}h to ${this.backupDir}`,
      );
    }

    // Daily review of due facts + index reconcile; first run 1h after startup
    const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    this.maintenanceStartupTimer = setTimeout(() => void this.runDailyMaintenance(), 60 * 60 * 1000);
    this.maintenanceTimer = setInterval(() => void this.runDailyMaintenance(), MAINTENANCE_INTERVAL_MS);

    // The memory batch queue: resume whatever a previous process left in flight, then keep it moving.
    void this.batchQueue.tick();
    this.batchTimer = setInterval(() => void this.batchQueue.tick(), BATCH_TICK_INTERVAL_MS);
  }

  onStop(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    if (this.maintenanceStartupTimer) {
      clearTimeout(this.maintenanceStartupTimer);
      this.maintenanceStartupTimer = null;
    }
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    this.groupDay().registerTask(new GroupDayMemoryTask(this.memoryExtractService, this.batchQueue));
    logger.info('[MemoryPlugin] Registered group_day task: memory');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    this.groupDay().unregisterTask(GroupDayMemoryTask.NAME);
    logger.info('[MemoryPlugin] Unregistered group_day task: memory');
  }

  private groupDay(): GroupDayFanout {
    return getContainer().resolve(GroupDayFanout);
  }

  /**
   * Daily maintenance, per group with memory: queue a review of every slot with due facts, then
   * bring the group's vector index back to its facts and manual lines.
   */
  private async runDailyMaintenance(): Promise<void> {
    const container = getContainer();
    const indexSync = container.resolve(MemoryIndexSync);
    const review = container.resolve(MemoryReviewService);
    try {
      for (const groupId of await indexSync.listGroupIds()) {
        const dueSlots = await review.listDueSlots(groupId);
        for (const userId of dueSlots) {
          await this.batchQueue.enqueueReview(groupId, userId);
        }
        const indexed = indexSync.isEnabled() ? await indexSync.reindexGroup(groupId) : { upserted: 0, removed: 0 };
        logger.info(
          `[MemoryPlugin] Daily maintenance group=${groupId} | review queued for ${dueSlots.length} slots ` +
            `| index upserted=${indexed.upserted} removed=${indexed.removed}`,
        );
      }
    } catch (err) {
      logger.warn('[MemoryPlugin] Daily maintenance failed:', err);
    }
  }

  /** Queue one extract per chunk and resolve once every one of them, with its consolidations, has settled. */
  private async extractChunks(groupId: string, chunks: string[], focusUserId?: string): Promise<boolean> {
    const handles: MemoryJobHandle[] = [];
    for (const chunk of chunks) {
      handles.push(await this.batchQueue.enqueueExtract(groupId, chunk, focusUserId));
    }
    const outcomes = await Promise.all(handles.map((handle) => handle.settled));
    return outcomes.every((outcome) => outcome.dropped === 0);
  }

  /**
   * Queue user memory extracts for messages since a given date.
   * Fire-and-forget; onComplete is called once every job has settled (in this process).
   */
  runExtractForUserSince(groupId: string, userId: string, since: Date, onComplete?: (success: boolean) => void): void {
    const key = `user-since:${groupId}:${userId}`;
    if (this.fullHistoryPendingKeys.has(key)) {
      logger.info(`[MemoryPlugin] runExtractForUserSince: already running, skip groupId=${groupId} userId=${userId}`);
      return;
    }
    this.fullHistoryPendingKeys.add(key);
    logger.info(
      `[MemoryPlugin] runExtractForUserSince started groupId=${groupId} userId=${userId} since=${since.toISOString()}`,
    );
    void this.runExtractForUserSinceInternal(groupId, userId, since)
      .then((success) => onComplete?.(success))
      .catch((err) => {
        logger.error(`[MemoryPlugin] runExtractForUserSince error groupId=${groupId} userId=${userId}`, err);
        onComplete?.(false);
      })
      .finally(() => {
        this.fullHistoryPendingKeys.delete(key);
      });
  }

  private async runExtractForUserSinceInternal(groupId: string, userId: string, since: Date): Promise<boolean> {
    const entries = await this.conversationHistoryService.getMessagesSince(groupId, since);
    // Filter to only this user's messages
    const userEntries = entries.filter((e) => String(e.userId) === userId);
    if (userEntries.length === 0) {
      logger.info(
        `[MemoryPlugin] runExtractForUserSince: no messages for groupId=${groupId} userId=${userId} since=${since.toISOString()}, skip`,
      );
      return true;
    }
    const text = this.conversationHistoryService.formatAsText(userEntries);
    const chunks = chunkLines(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runExtractForUserSince: processing groupId=${groupId} userId=${userId} messages=${userEntries.length} chunks=${chunks.length}`,
    );
    const success = await this.extractChunks(groupId, chunks, userId);
    logger.info(
      `[MemoryPlugin] runExtractForUserSince settled groupId=${groupId} userId=${userId} chunks=${chunks.length} success=${success}`,
    );
    return success;
  }

  /**
   * Queue group memory extracts (group + user facts) for messages since a given date.
   * Fire-and-forget; onComplete is called once every job has settled (in this process).
   */
  runExtractForGroupSince(groupId: string, since: Date, onComplete?: (success: boolean) => void): void {
    const key = `group-since:${groupId}`;
    if (this.fullHistoryPendingKeys.has(key)) {
      logger.info(`[MemoryPlugin] runExtractForGroupSince: already running, skip groupId=${groupId}`);
      return;
    }
    this.fullHistoryPendingKeys.add(key);
    logger.info(`[MemoryPlugin] runExtractForGroupSince started groupId=${groupId} since=${since.toISOString()}`);
    void this.runExtractForGroupSinceInternal(groupId, since)
      .then((success) => onComplete?.(success))
      .catch((err) => {
        logger.error(`[MemoryPlugin] runExtractForGroupSince error groupId=${groupId}`, err);
        onComplete?.(false);
      })
      .finally(() => {
        this.fullHistoryPendingKeys.delete(key);
      });
  }

  private async runExtractForGroupSinceInternal(groupId: string, since: Date): Promise<boolean> {
    const entries = await this.conversationHistoryService.getMessagesSince(groupId, since);
    const filtered = this.botSelfId ? entries.filter((e) => String(e.userId) !== this.botSelfId) : entries;
    if (filtered.length === 0) {
      logger.info(
        `[MemoryPlugin] runExtractForGroupSince: no messages for groupId=${groupId} since=${since.toISOString()}, skip`,
      );
      return true;
    }
    const text = this.conversationHistoryService.formatAsText(filtered);
    const chunks = chunkLines(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runExtractForGroupSince: processing groupId=${groupId} messages=${filtered.length} chunks=${chunks.length}`,
    );
    const success = await this.extractChunks(groupId, chunks);
    logger.info(
      `[MemoryPlugin] runExtractForGroupSince settled groupId=${groupId} chunks=${chunks.length} success=${success}`,
    );
    return success;
  }

  /**
   * Daily-named snapshot of both memory sources: data/memory/ (manual files) as
   * memory-YYYY-MM-DD.tar.gz, and every `memory_facts` row as memory-facts-YYYY-MM-DD.json.
   */
  private async backupMemoryFiles(): Promise<void> {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const destDir = resolveFromRepoRoot(this.backupDir);
    try {
      await mkdir(destDir, { recursive: true });
      await this.archiveManualFiles(join(destDir, `memory-${date}.tar.gz`));
      await this.exportFacts(join(destDir, `memory-facts-${date}.json`));
    } catch (err) {
      logger.error('[MemoryPlugin] Memory backup failed:', err);
    }
  }

  private async archiveManualFiles(archivePath: string): Promise<void> {
    const srcDir = join(getRepoRoot(), MEMORY_DIR);
    if (!existsSync(srcDir) || existsSync(archivePath)) {
      return;
    }
    // tar from the parent dir so the archive holds `memory/...` rather than absolute paths.
    const proc = Bun.spawn(['tar', '-czf', archivePath, basename(srcDir)], {
      cwd: dirname(srcDir),
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar failed (exit ${exitCode}): ${stderr}`);
    }
    logger.info(`[MemoryPlugin] Manual memory backup → ${archivePath}`);
  }

  private async exportFacts(exportPath: string): Promise<void> {
    if (existsSync(exportPath)) {
      return;
    }
    const facts = await getContainer().resolve(MemoryFactStore).listAll();
    await writeFile(exportPath, JSON.stringify(facts, null, 2), 'utf-8');
    logger.info(`[MemoryPlugin] Memory facts backup (${facts.length} rows) → ${exportPath}`);
  }
}

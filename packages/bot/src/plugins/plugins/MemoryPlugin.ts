// Memory Plugin - daily memory extraction as a group_day fan-out task, full-history backfills,
// memory backups, and the daily review of due facts.

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryExtractUserCursor } from '@/database/models/types';
import { GroupDayFanout } from '@/fanout/contexts/groupDay/GroupDayFanout';
import { chunkLines } from '@/memory/chunkLines';
import { GroupDayMemoryTask } from '@/memory/GroupDayMemoryTask';
import { MemoryExtractService } from '@/memory/MemoryExtractService';
import { MemoryFactStore } from '@/memory/MemoryFactStore';
import { MemoryReviewService } from '@/memory/MemoryReviewService';
import { MemoryService } from '@/memory/MemoryService';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface MemoryPluginConfig {
  /** LLM provider for backfill extracts, consolidation and review (e.g. "gemini", "deepseek"). Required. */
  extractProvider: string;
  /** Model override for the extract provider (e.g. "gemini-3.1-flash-lite"). Default: the provider's configured model. */
  extractModel?: string;
  /** Full-history extract (via MemoryTrigger): max character length per extract chunk. Default 15000. */
  fullHistoryMaxLength?: number;
  /** Full-history progress file path (one line per "groupId:userId"). Default "data/memory_full_history_progress.txt". */
  fullHistoryProgressFile?: string;
  /** Backup interval in ms. Default 604800000 (7 days). Set to 0 to disable. */
  backupIntervalMs?: number;
  /** Backup directory path (relative to cwd). Default "data/backup/memory". */
  backupDir?: string;
}

const DEFAULT_FULL_HISTORY_MAX_LENGTH = 15_000;
const DEFAULT_FULL_HISTORY_PROGRESS_FILE = 'data/memory_full_history_progress.txt';
const DEFAULT_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_BACKUP_DIR = 'data/backup/memory';
const MEMORY_DIR = 'data/memory';

@RegisterPlugin({
  name: 'memory',
  version: '1.0.0',
  description: 'Memory: daily extract on the group_day prefix, full-history backfills, backups',
})
export class MemoryPlugin extends PluginBase {
  /** LLM provider name for extract + analyze (from config). */
  private extractProvider = '';
  private extractModel: string | undefined;
  /** Full-history extract (MemoryTrigger): max character length per extract chunk. */
  private fullHistoryMaxLength = DEFAULT_FULL_HISTORY_MAX_LENGTH;
  /** Full-history progress file path (one line per "groupId:userId"). */
  private fullHistoryProgressFile = DEFAULT_FULL_HISTORY_PROGRESS_FILE;

  /** Backup interval timer. */
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private backupIntervalMs = DEFAULT_BACKUP_INTERVAL_MS;
  private backupDir = DEFAULT_BACKUP_DIR;

  /** In-memory guard: groupId:userId currently running or queued for full-history extract; avoid duplicate runs. */
  private fullHistoryPendingKeys = new Set<string>();
  private conversationHistoryService!: ConversationHistoryService;
  private memoryExtractService!: MemoryExtractService;
  private databaseManager!: DatabaseManager;
  private botSelfId = '';

  async onInit(): Promise<void> {
    this.enabled = true;

    const container = getContainer();
    this.conversationHistoryService = container.resolve<ConversationHistoryService>(ConversationHistoryService);
    this.memoryExtractService = container.resolve(MemoryExtractService);
    this.databaseManager = container.resolve(DatabaseManager);

    const config = container.resolve<Config>(DITokens.CONFIG);
    this.botSelfId = config.getConfig().bot.selfId;

    const pluginConfig = this.pluginConfig?.config as MemoryPluginConfig | undefined;

    if (pluginConfig) {
      // Plugin config takes precedence over AI config
      this.extractProvider = pluginConfig.extractProvider;
      this.extractModel = pluginConfig.extractModel;
      this.fullHistoryMaxLength = pluginConfig.fullHistoryMaxLength ?? DEFAULT_FULL_HISTORY_MAX_LENGTH;
      this.fullHistoryProgressFile = pluginConfig.fullHistoryProgressFile ?? DEFAULT_FULL_HISTORY_PROGRESS_FILE;
      this.backupIntervalMs = pluginConfig.backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
      this.backupDir = pluginConfig.backupDir ?? DEFAULT_BACKUP_DIR;
      logger.info(
        `[MemoryPlugin] Configured | extractProvider=${this.extractProvider}${this.extractModel ? ` model=${this.extractModel}` : ''}`,
      );
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
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    this.groupDay().registerTask(
      new GroupDayMemoryTask(this.memoryExtractService, { provider: this.extractProvider, model: this.extractModel }),
    );
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
   * Daily maintenance, per group with memory: review the facts that are due (keep, retire or
   * merge them), then bring the group's vector index back to its facts.
   */
  private async runDailyMaintenance(): Promise<void> {
    const container = getContainer();
    const store = container.resolve(MemoryFactStore);
    const review = container.resolve(MemoryReviewService);
    const memory = container.resolve(MemoryService);
    const options = { provider: this.extractProvider, model: this.extractModel };
    try {
      for (const groupId of await store.listGroupIds()) {
        const reviewed = await review.reviewGroup(groupId, options);
        const indexed = memory.isSearchEnabled() ? await memory.reconcileIndex(groupId) : { upserted: 0, removed: 0 };
        logger.info(
          `[MemoryPlugin] Daily maintenance group=${groupId} | review due=${reviewed.due} kept=${reviewed.kept} ` +
            `retired=${reviewed.retired} merged=${reviewed.merged} | index upserted=${indexed.upserted} removed=${indexed.removed}`,
        );
      }
    } catch (err) {
      logger.warn('[MemoryPlugin] Daily maintenance failed:', err);
    }
  }

  /** Resolve full-history progress file path relative to repo root. */
  private getFullHistoryProgressPath(): string {
    return join(getRepoRoot(), this.fullHistoryProgressFile);
  }

  /** Load set of "groupId:userId" from full-history progress file. */
  private async loadFullHistoryProgress(): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const path = this.getFullHistoryProgressPath();
      const content = await readFile(path, 'utf-8');
      for (const line of content.split('\n')) {
        const key = line.trim();
        if (key) {
          set.add(key);
        }
      }
    } catch {
      // File may not exist yet
    }
    return set;
  }

  /** Append one "groupId:userId" line to full-history progress file (creates data dir if needed). */
  private async appendFullHistoryProgress(key: string): Promise<void> {
    const path = this.getFullHistoryProgressPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${key}\n`);
  }

  /** Upsert memory_extract_user_cursors so every run (trigger/skip/complete/error) leaves a record. */
  private async upsertMemoryExtractCursor(groupId: string, userId: string, lastProcessedAt: string): Promise<void> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return;
    }
    try {
      const userCursors = adapter.getModel('memoryExtractUserCursors');
      const existing = (await userCursors.findOne({
        groupId,
        userId,
      } as Partial<MemoryExtractUserCursor>)) as MemoryExtractUserCursor | null;
      if (existing) {
        await userCursors.update(existing.id, { lastProcessedAt });
      } else {
        await userCursors.create({ groupId, userId, lastProcessedAt } as Omit<
          MemoryExtractUserCursor,
          'id' | 'createdAt' | 'updatedAt'
        >);
      }
    } catch (err) {
      logger.warn('[MemoryPlugin] upsertMemoryExtractCursor failed:', err);
    }
  }

  /**
   * Run full-history extract for a single user (e.g. when user triggers via MemoryTrigger).
   * Loads all messages for that user in the group, chunks by fullHistoryMaxLength, and runs
   * one extractAndConsolidateUser per chunk. Fire-and-forget; does not block.
   * Skips if this groupId:userId was already processed (recorded in full-history progress file),
   * or if a full-history run for this user is already queued/running (in-memory guard to avoid duplicate work).
   */
  runFullHistoryExtractForUser(groupId: string, userId: string, onComplete?: (success: boolean) => void): void {
    if (this.botSelfId && String(userId) === this.botSelfId) {
      return;
    }
    const key = `${groupId}:${userId}`;
    if (this.fullHistoryPendingKeys.has(key)) {
      logger.info(
        `[MemoryPlugin] runFullHistoryExtractForUser: already queued or running, skip groupId=${groupId} userId=${userId}`,
      );
      return;
    }
    this.fullHistoryPendingKeys.add(key);
    logger.info(`[MemoryPlugin] runFullHistoryExtractForUser started groupId=${groupId} userId=${userId}`);
    void this.runFullHistoryExtractForUserInternal(groupId, userId)
      .then(() => {
        onComplete?.(true);
      })
      .catch((err) => {
        logger.error(
          `[MemoryPlugin] runFullHistoryExtractForUser unhandled error groupId=${groupId} userId=${userId}`,
          err,
        );
        onComplete?.(false);
      })
      .finally(() => {
        this.fullHistoryPendingKeys.delete(key);
      });
  }

  private async runFullHistoryExtractForUserInternal(groupId: string, userId: string): Promise<void> {
    // skip bot memory
    if (this.botSelfId && String(userId) === this.botSelfId) {
      return;
    }

    const key = `${groupId}:${userId}`;
    const progressSet = await this.loadFullHistoryProgress();
    if (progressSet.has(key)) {
      logger.info(
        `[MemoryPlugin] runFullHistoryExtractForUser: already processed, skip groupId=${groupId} userId=${userId}`,
      );
      await this.upsertMemoryExtractCursor(groupId, userId, new Date().toISOString());
      return;
    }

    const entries = await this.conversationHistoryService.getMessagesForUserInGroup(groupId, userId);
    if (entries.length === 0) {
      logger.info(
        `[MemoryPlugin] runFullHistoryExtractForUser: no messages for groupId=${groupId} userId=${userId}, writing progress to skip next time`,
      );
      await this.appendFullHistoryProgress(key);
      await this.upsertMemoryExtractCursor(groupId, userId, new Date().toISOString());
      return;
    }
    const text = this.conversationHistoryService.formatAsText(entries);
    const chunks = chunkLines(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runFullHistoryExtractForUser: processing groupId=${groupId} userId=${userId} messages=${entries.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    try {
      for (let i = 0; i < chunks.length; i++) {
        logger.info(
          `[MemoryPlugin] runFullHistoryExtractForUser chunk ${i + 1}/${chunks.length} groupId=${groupId} userId=${userId}`,
        );
        await this.memoryExtractService.extractAndConsolidateUser(groupId, userId, chunks[i], opts);
      }
      const latestEntry = entries[entries.length - 1];
      const lastProcessedAt = latestEntry?.createdAt
        ? new Date(latestEntry.createdAt).toISOString()
        : new Date().toISOString();
      await this.upsertMemoryExtractCursor(groupId, userId, lastProcessedAt);
      await this.appendFullHistoryProgress(key);
      logger.info(
        `[MemoryPlugin] Full history extract completed for groupId=${groupId} userId=${userId} chunks=${chunks.length} | progress file + user cursor written`,
      );
    } catch (err) {
      logger.error(
        `[MemoryPlugin] runFullHistoryExtractForUser failed (progress not written): groupId=${groupId} userId=${userId}`,
        err,
      );
      await this.upsertMemoryExtractCursor(groupId, userId, new Date().toISOString());
    }
  }

  /**
   * Run full-history extract for group memory (extractAndConsolidate handles both group + user facts).
   * Chunks the full conversation history and runs extract on each chunk.
   * Fire-and-forget; onComplete callback is called when done.
   */
  runFullHistoryExtractForGroup(groupId: string, onComplete?: (success: boolean) => void): void {
    const key = `group:${groupId}`;
    if (this.fullHistoryPendingKeys.has(key)) {
      logger.info(`[MemoryPlugin] runFullHistoryExtractForGroup: already running, skip groupId=${groupId}`);
      return;
    }
    this.fullHistoryPendingKeys.add(key);
    logger.info(`[MemoryPlugin] runFullHistoryExtractForGroup started groupId=${groupId}`);
    void this.runFullHistoryExtractForGroupInternal(groupId)
      .then(() => {
        onComplete?.(true);
      })
      .catch((err) => {
        logger.error(`[MemoryPlugin] runFullHistoryExtractForGroup error groupId=${groupId}`, err);
        onComplete?.(false);
      })
      .finally(() => {
        this.fullHistoryPendingKeys.delete(key);
      });
  }

  private async runFullHistoryExtractForGroupInternal(groupId: string): Promise<void> {
    const entries = await this.conversationHistoryService.getRecentMessages(groupId, 0);
    const filtered = this.botSelfId ? entries.filter((e) => String(e.userId) !== this.botSelfId) : entries;
    if (filtered.length === 0) {
      logger.info(`[MemoryPlugin] runFullHistoryExtractForGroup: no messages for groupId=${groupId}, skip`);
      return;
    }
    const text = this.conversationHistoryService.formatAsText(filtered);
    const chunks = chunkLines(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runFullHistoryExtractForGroup: processing groupId=${groupId} messages=${filtered.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`[MemoryPlugin] runFullHistoryExtractForGroup chunk ${i + 1}/${chunks.length} groupId=${groupId}`);
      await this.memoryExtractService.extractAndConsolidate(groupId, chunks[i], opts);
    }
    logger.info(`[MemoryPlugin] Full history group extract completed for groupId=${groupId} chunks=${chunks.length}`);
  }

  /**
   * Run user memory extract for messages since a given date.
   * Fire-and-forget; onComplete callback is called when done.
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
      .then(() => onComplete?.(true))
      .catch((err) => {
        logger.error(`[MemoryPlugin] runExtractForUserSince error groupId=${groupId} userId=${userId}`, err);
        onComplete?.(false);
      })
      .finally(() => {
        this.fullHistoryPendingKeys.delete(key);
      });
  }

  private async runExtractForUserSinceInternal(groupId: string, userId: string, since: Date): Promise<void> {
    const entries = await this.conversationHistoryService.getMessagesSince(groupId, since);
    // Filter to only this user's messages
    const userEntries = entries.filter((e) => String(e.userId) === userId);
    if (userEntries.length === 0) {
      logger.info(
        `[MemoryPlugin] runExtractForUserSince: no messages for groupId=${groupId} userId=${userId} since=${since.toISOString()}, skip`,
      );
      return;
    }
    const text = this.conversationHistoryService.formatAsText(userEntries);
    const chunks = chunkLines(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runExtractForUserSince: processing groupId=${groupId} userId=${userId} messages=${userEntries.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    for (let i = 0; i < chunks.length; i++) {
      logger.info(
        `[MemoryPlugin] runExtractForUserSince chunk ${i + 1}/${chunks.length} groupId=${groupId} userId=${userId}`,
      );
      await this.memoryExtractService.extractAndConsolidateUser(groupId, userId, chunks[i], opts);
    }
    logger.info(
      `[MemoryPlugin] runExtractForUserSince completed groupId=${groupId} userId=${userId} chunks=${chunks.length}`,
    );
  }

  /**
   * Run group memory extract (group + user facts) for messages since a given date.
   * Fire-and-forget; onComplete callback is called when done.
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
      .then(() => onComplete?.(true))
      .catch((err) => {
        logger.error(`[MemoryPlugin] runExtractForGroupSince error groupId=${groupId}`, err);
        onComplete?.(false);
      })
      .finally(() => {
        this.fullHistoryPendingKeys.delete(key);
      });
  }

  private async runExtractForGroupSinceInternal(groupId: string, since: Date): Promise<void> {
    const entries = await this.conversationHistoryService.getMessagesSince(groupId, since);
    const filtered = this.botSelfId ? entries.filter((e) => String(e.userId) !== this.botSelfId) : entries;
    if (filtered.length === 0) {
      logger.info(
        `[MemoryPlugin] runExtractForGroupSince: no messages for groupId=${groupId} since=${since.toISOString()}, skip`,
      );
      return;
    }
    const text = this.conversationHistoryService.formatAsText(filtered);
    const chunks = chunkLines(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runExtractForGroupSince: processing groupId=${groupId} messages=${filtered.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`[MemoryPlugin] runExtractForGroupSince chunk ${i + 1}/${chunks.length} groupId=${groupId}`);
      await this.memoryExtractService.extractAndConsolidate(groupId, chunks[i], opts);
    }
    logger.info(`[MemoryPlugin] runExtractForGroupSince completed groupId=${groupId} chunks=${chunks.length}`);
  }

  /**
   * Daily-named snapshot of both memory sources: data/memory/ (manual files) as
   * memory-YYYY-MM-DD.tar.gz, and every `memory_facts` row as memory-facts-YYYY-MM-DD.json.
   */
  private async backupMemoryFiles(): Promise<void> {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const destDir = join(getRepoRoot(), this.backupDir);
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

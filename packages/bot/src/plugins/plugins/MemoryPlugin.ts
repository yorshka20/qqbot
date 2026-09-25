// Memory Plugin - daily memory extraction as a group_day fan-out task, full-history backfills,
// memory backups and stale-fact cleanup.

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ConversationHistoryService } from '@/conversation/history';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryExtractUserCursor } from '@/database/models/types';
import { GroupDayFanout } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { MemoryExtractService } from '@/memory';
import { GroupDayMemoryTask } from '@/memory/GroupDayMemoryTask';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface MemoryPluginConfig {
  /** LLM provider for backfill extracts and for merging extracted facts (e.g. "gemini", "deepseek"). Required. */
  extractProvider: string;
  /** Model override for the extract provider (e.g. "gemini-3.1-flash-lite"). Default: the provider's configured model. */
  extractModel?: string;
  /** Full-history extract (via MemoryTrigger): max character length per extract chunk. Default 15000. */
  fullHistoryMaxLength?: number;
  /** Full-history progress file path (one line per "groupId:userId"). Default "data/memory_full_history_progress.txt". */
  fullHistoryProgressFile?: string;
  /** Backup interval in ms. Default 604800000 (7 days). Set to 0 to disable. */
  backupIntervalMs?: number;
  /** Backup directory path (relative to cwd). Default "data/backups/memory". */
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
    this.conversationHistoryService = container.resolve<ConversationHistoryService>(
      DITokens.CONVERSATION_HISTORY_SERVICE,
    );
    this.memoryExtractService = container.resolve<MemoryExtractService>(DITokens.MEMORY_EXTRACT_SERVICE);
    this.databaseManager = container.resolve<DatabaseManager>(DITokens.DATABASE_MANAGER);

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

    // Daily memory fact cleanup (stale/zombie detection)
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    setTimeout(() => void this.runDailyCleanup(), 60 * 60 * 1000); // 1h after startup
    setInterval(() => void this.runDailyCleanup(), CLEANUP_INTERVAL_MS);
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
   * Daily cleanup: mark zombie facts as stale, hard-delete old stale facts.
   */
  private async runDailyCleanup(): Promise<void> {
    try {
      const { MemoryFactMetaService } = await import('@/memory/MemoryFactMetaService');
      let factMetaService: InstanceType<typeof MemoryFactMetaService>;
      try {
        factMetaService = getContainer().resolve(DITokens.MEMORY_FACT_META_SERVICE);
      } catch {
        return; // Not registered (non-SQLite)
      }

      // Rule 1: stale > 30 days → hard delete
      const STALE_HARD_DELETE_MS = 30 * 24 * 60 * 60 * 1000;
      const staleFacts = factMetaService.getStaleFacts(STALE_HARD_DELETE_MS);
      if (staleFacts.length > 0) {
        factMetaService.deleteMany(staleFacts.map((f) => f.factHash));
        logger.info(`[MemoryPlugin] Cleanup: deleted ${staleFacts.length} stale facts (>30d)`);
      }

      // Rule 2: active but 180d no reinforce + hitCount=0 → demote to stale
      const ZOMBIE_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000;
      const zombieFacts = factMetaService.getZombieFacts(ZOMBIE_THRESHOLD_MS);
      for (const fact of zombieFacts) {
        factMetaService.markStale(fact.factHash);
      }
      if (zombieFacts.length > 0) {
        logger.info(`[MemoryPlugin] Cleanup: demoted ${zombieFacts.length} zombie facts to stale`);
      }
    } catch (err) {
      logger.warn('[MemoryPlugin] Daily cleanup failed:', err);
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

  /** Split text into chunks by line, each chunk <= maxLength (by character). */
  private chunkTextByMaxLength(text: string, maxLength: number): string[] {
    if (!text.trim()) {
      return [];
    }
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current: string[] = [];
    let currentLen = 0;
    for (const line of lines) {
      const lineLen = line.length + 1;
      if (currentLen + lineLen > maxLength && current.length > 0) {
        chunks.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      current.push(line);
      currentLen += lineLen;
    }
    if (current.length > 0) {
      chunks.push(current.join('\n'));
    }
    return chunks;
  }

  /**
   * Run full-history extract for a single user (e.g. when user triggers via MemoryTrigger).
   * Loads all messages for that user in the group, chunks by fullHistoryMaxLength, and runs
   * one extractAndUpsertUserOnly per chunk. Fire-and-forget; does not block.
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
    const chunks = this.chunkTextByMaxLength(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runFullHistoryExtractForUser: processing groupId=${groupId} userId=${userId} messages=${entries.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    try {
      for (let i = 0; i < chunks.length; i++) {
        logger.info(
          `[MemoryPlugin] runFullHistoryExtractForUser chunk ${i + 1}/${chunks.length} groupId=${groupId} userId=${userId}`,
        );
        await this.memoryExtractService.extractAndUpsertUserOnly(groupId, userId, chunks[i], opts);
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
   * Run full-history extract for group memory (extractAndUpsert handles both group + user facts).
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
    const chunks = this.chunkTextByMaxLength(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runFullHistoryExtractForGroup: processing groupId=${groupId} messages=${filtered.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`[MemoryPlugin] runFullHistoryExtractForGroup chunk ${i + 1}/${chunks.length} groupId=${groupId}`);
      await this.memoryExtractService.extractAndUpsert(groupId, chunks[i], opts);
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
    const chunks = this.chunkTextByMaxLength(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runExtractForUserSince: processing groupId=${groupId} userId=${userId} messages=${userEntries.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    for (let i = 0; i < chunks.length; i++) {
      logger.info(
        `[MemoryPlugin] runExtractForUserSince chunk ${i + 1}/${chunks.length} groupId=${groupId} userId=${userId}`,
      );
      await this.memoryExtractService.extractAndUpsertUserOnly(groupId, userId, chunks[i], opts);
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
    const chunks = this.chunkTextByMaxLength(text, this.fullHistoryMaxLength);
    logger.info(
      `[MemoryPlugin] runExtractForGroupSince: processing groupId=${groupId} messages=${filtered.length} chunks=${chunks.length}`,
    );
    const opts = { provider: this.extractProvider, model: this.extractModel };
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`[MemoryPlugin] runExtractForGroupSince chunk ${i + 1}/${chunks.length} groupId=${groupId}`);
      await this.memoryExtractService.extractAndUpsert(groupId, chunks[i], opts);
    }
    logger.info(`[MemoryPlugin] runExtractForGroupSince completed groupId=${groupId} chunks=${chunks.length}`);
  }

  /**
   * Backup all memory files into a compressed snapshot.
   * Archives data/memory/ → data/backup/memory/memory-YYYY-MM-DD.tar.gz (one per day, source kept).
   */
  private async backupMemoryFiles(): Promise<void> {
    const srcDir = join(getRepoRoot(), MEMORY_DIR);
    if (!existsSync(srcDir)) {
      logger.debug('[MemoryPlugin] No memory directory to backup');
      return;
    }
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const destDir = join(getRepoRoot(), this.backupDir);
    const archivePath = join(destDir, `memory-${date}.tar.gz`);
    if (existsSync(archivePath)) {
      logger.debug(`[MemoryPlugin] Memory backup already exists: memory-${date}.tar.gz`);
      return;
    }
    try {
      await mkdir(destDir, { recursive: true });
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
      logger.info(`[MemoryPlugin] Memory backup completed → ${archivePath}`);
    } catch (err) {
      logger.error('[MemoryPlugin] Memory backup failed:', err);
    }
  }
}

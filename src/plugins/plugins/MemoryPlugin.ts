// Memory Plugin - debounced memory extraction from recent messages for configured groups

import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConversationHistoryService } from '@/conversation/history';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryExtractUserCursor } from '@/database/models/types';
import type { HookContext, HookResult } from '@/hooks/types';
import type { MemoryExtractService } from '@/memory';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface MemoryPluginConfig {
  /** Group IDs that have memory extraction enabled. */
  groups: string[];
  /** Debounce delay in ms before running extract after last message. Default 600000 (10 min). Use a larger value (e.g. 10 min) to avoid extract running too often and filling the queue; small values (e.g. 10s) cause frequent group extracts and can make memory extract appear to run non-stop. */
  debounceMs: number;
  /** LLM provider for extract (e.g. "deepseek", "doubao"). Required. */
  extractProvider: string;
  /** Full-history extract (via MemoryTrigger): max character length per extract chunk. Default 15000. */
  fullHistoryMaxLength?: number;
  /** Full-history progress file path (one line per "groupId:userId"). Default "data/memory_full_history_progress.txt". */
  fullHistoryProgressFile?: string;
  /** Max messages per debounced extract run (per group). Progress is stored per user in DB (memory_extract_user_cursors) when triggered via MemoryTrigger. */
  maxMessagesPerExtract?: number;
  /** Backup interval in ms. Default 604800000 (7 days). Set to 0 to disable. */
  backupIntervalMs?: number;
  /** Backup directory path (relative to cwd). Default "data/backups/memory". */
  backupDir?: string;
}

const DEFAULT_DEBOUNCE_MS = 6000_000; // 100 min; short debounce (e.g. 10s) causes frequent group extracts and queue buildup
const DEFAULT_FULL_HISTORY_MAX_LENGTH = 15_000;
const DEFAULT_FULL_HISTORY_PROGRESS_FILE = 'data/memory_full_history_progress.txt';
const DEFAULT_MAX_MESSAGES_PER_EXTRACT = 500;
const DEFAULT_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_BACKUP_DIR = 'data/backup/memory';
const MEMORY_DIR = 'data/memory';

@RegisterPlugin({
  name: 'memory',
  version: '1.0.0',
  description: 'Memory: debounced extract from recent messages for configured groups, inject into replies',
})
export class MemoryPlugin extends PluginBase {
  /** Group IDs that have memory extraction enabled (from config). */
  private groupIds = new Set<string>();
  /** Debounce delay in ms; extract runs after this idle time since last message. */
  private debounceMs = DEFAULT_DEBOUNCE_MS;
  /** LLM provider name for extract + analyze (from config). */
  private extractProvider = '';
  /** Full-history extract (MemoryTrigger): max character length per extract chunk. */
  private fullHistoryMaxLength = DEFAULT_FULL_HISTORY_MAX_LENGTH;
  /** Full-history progress file path (one line per "groupId:userId"). */
  private fullHistoryProgressFile = DEFAULT_FULL_HISTORY_PROGRESS_FILE;
  /** When using cursor (DB): cap messages per run; next debounce continues. */
  private maxMessagesPerExtract = DEFAULT_MAX_MESSAGES_PER_EXTRACT;

  /** Backup interval timer. */
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private backupIntervalMs = DEFAULT_BACKUP_INTERVAL_MS;
  private backupDir = DEFAULT_BACKUP_DIR;

  /** Per-group debounce timer: clear on new message, run extract when timer fires. */
  private timersByGroup = new Map<string, ReturnType<typeof setTimeout>>();
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

    if (pluginConfig?.groups.length) {
      this.groupIds = new Set(pluginConfig.groups);
      this.debounceMs = pluginConfig.debounceMs ?? DEFAULT_DEBOUNCE_MS;
      // Plugin config takes precedence over AI config
      this.extractProvider = pluginConfig.extractProvider;
      this.fullHistoryMaxLength = pluginConfig.fullHistoryMaxLength ?? DEFAULT_FULL_HISTORY_MAX_LENGTH;
      this.fullHistoryProgressFile = pluginConfig.fullHistoryProgressFile ?? DEFAULT_FULL_HISTORY_PROGRESS_FILE;
      this.maxMessagesPerExtract = pluginConfig.maxMessagesPerExtract ?? DEFAULT_MAX_MESSAGES_PER_EXTRACT;
      this.backupIntervalMs = pluginConfig.backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
      this.backupDir = pluginConfig.backupDir ?? DEFAULT_BACKUP_DIR;
      logger.info(
        `[MemoryPlugin] Enabled | groups=${Array.from(this.groupIds).join(', ')} debounceMs=${this.debounceMs} maxPerExtract=${this.maxMessagesPerExtract} extractProvider=${this.extractProvider}`,
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
  }

  /** Resolve full-history progress file path relative to cwd. */
  private getFullHistoryProgressPath(): string {
    return join(process.cwd(), this.fullHistoryProgressFile);
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

  /** Schedule extract for group after debounceMs; resets timer on each call. */
  private scheduleExtract(groupId: string): void {
    const existing = this.timersByGroup.get(groupId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timersByGroup.delete(groupId);
      void this.runExtractForGroup(groupId);
    }, this.debounceMs);
    this.timersByGroup.set(groupId, timer);
  }

  /**
   * Normal (debounced) flow: get recent messages for the group and run extract (no group-level cursor; user progress is per user in memory_extract_user_cursors).
   * Excludes bot's own messages from extract (bot selfId from config).
   */
  private async runExtractForGroup(groupId: string): Promise<void> {
    const entries = await this.conversationHistoryService.getRecentMessages(groupId, this.maxMessagesPerExtract);
    const filtered = this.botSelfId ? entries.filter((e) => String(e.userId) !== this.botSelfId) : entries;
    if (filtered.length === 0) {
      return;
    }
    const recentMessagesText = this.conversationHistoryService.formatAsText(filtered);
    await this.memoryExtractService.extractAndUpsert(groupId, recentMessagesText, {
      provider: this.extractProvider,
    });
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
    const opts = { provider: this.extractProvider };
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
    const opts = { provider: this.extractProvider };
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
    const opts = { provider: this.extractProvider };
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
    const opts = { provider: this.extractProvider };
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`[MemoryPlugin] runExtractForGroupSince chunk ${i + 1}/${chunks.length} groupId=${groupId}`);
      await this.memoryExtractService.extractAndUpsert(groupId, chunks[i], opts);
    }
    logger.info(`[MemoryPlugin] runExtractForGroupSince completed groupId=${groupId} chunks=${chunks.length}`);
  }

  /**
   * Backup all memory files to timestamped directory.
   * Copies data/memory/ → data/backup/memory/YYYY-MM-DD/
   */
  private async backupMemoryFiles(): Promise<void> {
    const srcDir = join(process.cwd(), MEMORY_DIR);
    if (!existsSync(srcDir)) {
      logger.debug('[MemoryPlugin] No memory directory to backup');
      return;
    }
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const destDir = join(process.cwd(), this.backupDir, date);
    try {
      await mkdir(destDir, { recursive: true });
      await cp(srcDir, destDir, { recursive: true });
      logger.info(`[MemoryPlugin] Memory backup completed → ${destDir}`);
    } catch (err) {
      logger.error('[MemoryPlugin] Memory backup failed:', err);
    }
  }

  /** On message complete: schedule debounced extract for configured groups (lower frequency). */
  @Hook({
    stage: 'onMessageComplete',
    priority: 'NORMAL',
    order: 5,
  })
  onMessageComplete(context: HookContext): HookResult {
    if (!this.enabled || this.groupIds.size === 0) {
      return true;
    }
    // Do not schedule memory extract for command messages; command content should not be processed by LLM.
    if (context.command) {
      return true;
    }
    const groupId = context.message?.groupId?.toString();
    const messageType = context.message?.messageType;
    if (messageType !== 'group' || !groupId || !this.groupIds.has(groupId)) {
      return true;
    }
    this.scheduleExtract(groupId);
    return true;
  }
}

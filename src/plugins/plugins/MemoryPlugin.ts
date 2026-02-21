// Memory Plugin - debounced memory extraction from recent messages for configured groups

import type { GroupHistoryService, GroupMessageEntry } from '@/conversation/thread';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryExtractCursor, Message } from '@/database/models/types';
import type { HookContext, HookResult } from '@/hooks/types';
import type { MemoryExtractService } from '@/memory';
import { logger } from '@/utils/logger';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface MemoryPluginConfig {
  /** Group IDs that have memory extraction enabled. */
  groups?: string[];
  /** Debounce delay in ms before running extract after last message. Default 120000 (2 min). */
  debounceMs?: number;
  /** LLM provider for extract (e.g. "ollama"). Default "ollama". */
  extractProvider?: string;
  /** Run cold-start extract on plugin init (async, non-blocking). Default false. Normally full-history extract is triggered only via MemoryTrigger. */
  coldStartOnInit?: boolean;
  /** Cold start (if enabled): only process this user ID; omit to process all users in each group. */
  coldStartOnlyUserId?: string;
  /** Cold start: max character length per extract chunk. Default 12000. */
  coldStartMaxLength?: number;
  /** Cold start: progress file path (one line per "groupId:userId"). Default "data/memory_coldstart_progress.txt". */
  coldStartProgressFile?: string;
  /** When using cursor: max messages per extract run (remaining messages processed in next debounce). Default 500. Cursor stored in DB (memory_extract_cursors). */
  maxMessagesPerExtract?: number;
}

const DEFAULT_DEBOUNCE_MS = 120_000;
const DEFAULT_COLDSTART_MAX_LENGTH = 15_000;
const DEFAULT_COLDSTART_PROGRESS_FILE = 'data/memory_coldstart_progress.txt';
const DEFAULT_MAX_MESSAGES_PER_EXTRACT = 500;

@Plugin({
  name: 'memory',
  version: '1.0.0',
  description: 'Memory: debounced extract from recent messages for configured groups, inject into replies',
})
export class MemoryPlugin extends PluginBase {
  /** Group IDs that have memory extraction enabled (from config). */
  private groupIds = new Set<string>();
  /** Debounce delay in ms; extract runs after this idle time since last message. */
  private debounceMs = DEFAULT_DEBOUNCE_MS;
  /** LLM provider name for extract + analyze (e.g. "ollama"). */
  private extractProvider = 'ollama';
  /** If true, run cold-start per-user extract on plugin init (background). */
  private coldStartOnInit = false;
  /** Cold start: only this user when set; otherwise all users. */
  private coldStartOnlyUserId: string | undefined;
  /** Cold start: max character length per extract chunk. */
  private coldStartMaxLength = DEFAULT_COLDSTART_MAX_LENGTH;
  /** Cold start: progress file path. */
  private coldStartProgressFile = DEFAULT_COLDSTART_PROGRESS_FILE;
  /** When using cursor (DB): cap messages per run; next debounce continues. */
  private maxMessagesPerExtract = DEFAULT_MAX_MESSAGES_PER_EXTRACT;

  /** Per-group debounce timer: clear on new message, run extract when timer fires. */
  private timersByGroup = new Map<string, ReturnType<typeof setTimeout>>();
  private groupHistoryService!: GroupHistoryService;
  private memoryExtractService!: MemoryExtractService;
  private databaseManager!: DatabaseManager;

  async onInit(): Promise<void> {
    this.enabled = true;
    const container = getContainer();
    this.groupHistoryService = container.resolve<GroupHistoryService>(DITokens.GROUP_HISTORY_SERVICE);
    this.memoryExtractService = container.resolve<MemoryExtractService>(DITokens.MEMORY_EXTRACT_SERVICE);
    this.databaseManager = container.resolve<DatabaseManager>(DITokens.DATABASE_MANAGER);

    const pluginConfig = this.pluginConfig?.config as MemoryPluginConfig | undefined;
    if (pluginConfig?.groups?.length) {
      this.groupIds = new Set(pluginConfig.groups);
      this.debounceMs = pluginConfig.debounceMs ?? DEFAULT_DEBOUNCE_MS;
      this.extractProvider = pluginConfig.extractProvider ?? 'ollama';
      this.coldStartOnInit = pluginConfig.coldStartOnInit ?? false;
      this.coldStartOnlyUserId = pluginConfig.coldStartOnlyUserId;
      this.coldStartMaxLength = pluginConfig.coldStartMaxLength ?? DEFAULT_COLDSTART_MAX_LENGTH;
      this.coldStartProgressFile = pluginConfig.coldStartProgressFile ?? DEFAULT_COLDSTART_PROGRESS_FILE;
      this.maxMessagesPerExtract = pluginConfig.maxMessagesPerExtract ?? DEFAULT_MAX_MESSAGES_PER_EXTRACT;
      logger.info(
        `[MemoryPlugin] Enabled | groups=${Array.from(this.groupIds).join(', ')} debounceMs=${this.debounceMs} maxPerExtract=${this.maxMessagesPerExtract} (cursor in DB)`,
      );
      if (this.coldStartOnInit) {
        setImmediate(() => {
          void this.runColdStart();
        });
      }
    }
  }

  /**
   * Cold start: process one user per group at a time; load all messages for that user from DB,
   * chunk by maxLength, run extract + merge per chunk, then append groupId:userId to progress file.
   * Logs full plan first, then progress so you can track and kill process if needed.
   */
  private async runColdStart(): Promise<void> {
    const progressSet = await this.loadColdStartProgress();
    const opts = { provider: this.extractProvider };
    const progressPath = this.getColdStartProgressPath();

    logger.info(`[MemoryPlugin] Cold start started | groups=${this.groupIds.size} | already_done=${progressSet.size} | progress_file=${progressPath}`);

    // Build and log full plan (group:user -> messages, chunks) so you see the whole run at a glance
    const plan: Array<{ key: string; messages: number; chunks: number }> = [];
    for (const groupId of this.groupIds) {
      const conversation = await this.getGroupConversation(groupId);
      if (!conversation) {
        continue;
      }
      const userIds = await this.getUserIdsForColdStart(conversation.id, groupId);
      for (const userId of userIds) {
        const key = `${groupId}:${userId}`;
        if (progressSet.has(key)) {
          continue;
        }
        const entries = await this.getUserMessagesInGroup(conversation.id, userId);
        const chunks = entries.length === 0 ? 0 : this.chunkTextByMaxLength(this.groupHistoryService.formatAsText(entries), this.coldStartMaxLength).length;
        plan.push({ key, messages: entries.length, chunks });
      }
    }
    logger.info(`[MemoryPlugin] Cold start full plan (order of work):`);
    if (plan.length === 0) {
      logger.info(`[MemoryPlugin] Cold start plan: nothing to do (all done or no messages)`);
    } else {
      for (let i = 0; i < plan.length; i++) {
        const { key, messages, chunks } = plan[i];
        logger.info(`[MemoryPlugin]   ${i + 1}. ${key} | messages=${messages} chunks=${chunks}`);
      }
      logger.info(`[MemoryPlugin] Cold start executing (total ${plan.length} user(s))...`);
    }

    let groupIndex = 0;
    for (const groupId of this.groupIds) {
      groupIndex += 1;
      const conversation = await this.getGroupConversation(groupId);
      if (!conversation) {
        logger.warn(`[MemoryPlugin] Cold start group ${groupId} skipped (no conversation)`);
        continue;
      }

      const userIds = await this.getUserIdsForColdStart(conversation.id, groupId);
      logger.info(`[MemoryPlugin] Cold start group ${groupId} (${groupIndex}/${this.groupIds.size}) | users_to_process=${userIds.length}`);

      for (const userId of userIds) {
        const key = `${groupId}:${userId}`;
        if (progressSet.has(key)) {
          logger.info(`[MemoryPlugin] Cold start skip (already done): ${key}`);
          continue;
        }

        try {
          const entries = await this.getUserMessagesInGroup(conversation.id, userId);
          if (entries.length === 0) {
            logger.info(`[MemoryPlugin] Cold start ${key} no messages, marking done`);
            await this.appendColdStartProgress(key);
            continue;
          }

          const fullText = this.groupHistoryService.formatAsText(entries);
          const chunks = this.chunkTextByMaxLength(fullText, this.coldStartMaxLength);
          const totalChunks = chunks.length;
          logger.info(`[MemoryPlugin] Cold start ${key} START | messages=${entries.length} chunks=${totalChunks} (kill process here to stop before this user)`);

          for (let i = 0; i < chunks.length; i++) {
            const current = i + 1;
            logger.info(`[MemoryPlugin] Cold start ${key} chunk ${current}/${totalChunks} starting...`);
            await this.memoryExtractService.extractAndUpsertUserOnly(groupId, userId, chunks[i], opts);
            logger.info(`[MemoryPlugin] Cold start ${key} chunk ${current}/${totalChunks} done (kill after this chunk = user not in progress file)`);
          }

          await this.appendColdStartProgress(key);
          logger.info(`[MemoryPlugin] Cold start ${key} COMPLETED | saved to progress file`);
        } catch (err) {
          logger.warn(`[MemoryPlugin] Cold start failed for ${key}:`, err);
        }
      }
    }

    logger.info(`[MemoryPlugin] Cold start finished`);
  }

  /** Resolve progress file path relative to cwd (e.g. data/memory_coldstart_progress.txt). */
  private getColdStartProgressPath(): string {
    return join(process.cwd(), this.coldStartProgressFile);
  }

  /** Load set of "groupId:userId" from progress file. */
  private async loadColdStartProgress(): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const path = this.getColdStartProgressPath();
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

  /** Append one "groupId:userId" line to progress file (creates data dir if needed). */
  private async appendColdStartProgress(key: string): Promise<void> {
    const path = this.getColdStartProgressPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, key + '\n');
  }

  private async getGroupConversation(groupId: string): Promise<{ id: string } | null> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return null;
    }
    const conversations = adapter.getModel('conversations');
    const conv = await conversations.findOne({
      sessionId: `group:${groupId}`,
      sessionType: 'group',
    });
    return conv ? { id: conv.id } : null;
  }

  /** Get user IDs to process for cold start: coldStartOnlyUserId if set, else distinct userIds in this group. */
  private async getUserIdsForColdStart(conversationId: string, groupId: string): Promise<string[]> {
    if (this.coldStartOnlyUserId) {
      return [this.coldStartOnlyUserId];
    }
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }
    const messages = adapter.getModel('messages');
    const all = await messages.find({ conversationId } as Partial<Message>);
    const userIds = new Set<string>();
    for (const msg of all as Message[]) {
      userIds.add(String(msg.userId));
    }
    return Array.from(userIds);
  }

  /** Load all messages for a user in a group conversation, sorted by createdAt, as GroupMessageEntry[]. */
  private async getUserMessagesInGroup(conversationId: string, userId: string): Promise<GroupMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }
    const messages = adapter.getModel('messages');
    const userIdNum = Number(userId);
    const list = await messages.find({
      conversationId,
      userId: Number.isNaN(userIdNum) ? userId : userIdNum,
    } as Partial<Message>);
    const sorted = (list as Message[]).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return sorted.map((msg) => {
      const meta = (msg.metadata as Record<string, unknown>) || {};
      const sender = meta.sender as { nickname?: string; card?: string } | undefined;
      const nickname = sender?.nickname ?? sender?.card;
      return {
        userId: msg.userId,
        nickname: typeof nickname === 'string' ? nickname : undefined,
        content: msg.content,
        isBotReply: meta.isBotReply === true,
        createdAt: new Date(msg.createdAt),
        wasAtBot: meta.wasAtBot === true,
      };
    });
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
   * Normal (debounced) flow: get messages since last processed (cursor in DB) so burst and restart do not miss messages.
   */
  private async runExtractForGroup(groupId: string): Promise<void> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return;
    }
    const cursors = adapter.getModel('memoryExtractCursors');
    const row = await cursors.findOne({ groupId } as Partial<MemoryExtractCursor>) as MemoryExtractCursor | null;
    const since = row?.lastProcessedAt ? new Date(row.lastProcessedAt) : null;

    const entries = since
      ? await this.groupHistoryService.getMessagesSince(groupId, since, this.maxMessagesPerExtract)
      : await this.groupHistoryService.getRecentMessages(groupId, this.maxMessagesPerExtract);

    if (entries.length === 0) {
      return;
    }

    const recentMessagesText = this.groupHistoryService.formatAsText(entries);
    await this.memoryExtractService.extractAndUpsert(groupId, recentMessagesText, {
      provider: this.extractProvider,
    });

    const latest = entries.reduce((max, e) => {
      const t = e.createdAt.getTime();
      return t > max ? t : max;
    }, 0);
    const isoDate = new Date(latest).toISOString();
    if (row) {
      await cursors.update(row.id, { lastProcessedAt: isoDate });
    } else {
      await cursors.create({ groupId, lastProcessedAt: isoDate } as Omit<MemoryExtractCursor, 'id' | 'createdAt' | 'updatedAt'>);
    }
  }

  /**
   * Run full-history extract for a single user (e.g. when user triggers via MemoryTrigger).
   * Loads all messages for that user in the group, chunks by coldStartMaxLength, and enqueues
   * one extractAndUpsertUserOnly per chunk. Jobs run in the same queue as normal extract, so
   * if extract is already running they are queued. Fire-and-forget; does not block.
   * Skips if this groupId:userId was already processed (same progress file as cold start).
   */
  runFullHistoryExtractForUser(groupId: string, userId: string): void {
    void this.runFullHistoryExtractForUserInternal(groupId, userId);
  }

  private async runFullHistoryExtractForUserInternal(groupId: string, userId: string): Promise<void> {
    const key = `${groupId}:${userId}`;
    const progressSet = await this.loadColdStartProgress();
    if (progressSet.has(key)) {
      logger.debug(`[MemoryPlugin] runFullHistoryExtractForUser: already processed, skip groupId=${groupId} userId=${userId}`);
      return;
    }
    const conversation = await this.getGroupConversation(groupId);
    if (!conversation) {
      logger.warn(`[MemoryPlugin] runFullHistoryExtractForUser: no conversation for groupId=${groupId}`);
      return;
    }
    const entries = await this.getUserMessagesInGroup(conversation.id, userId);
    if (entries.length === 0) {
      logger.debug(`[MemoryPlugin] runFullHistoryExtractForUser: no messages for groupId=${groupId} userId=${userId}`);
      return;
    }
    const text = this.groupHistoryService.formatAsText(entries);
    const chunks = this.chunkTextByMaxLength(text, this.coldStartMaxLength);
    const opts = { provider: this.extractProvider };
    for (const chunk of chunks) {
      await this.memoryExtractService.extractAndUpsertUserOnly(groupId, userId, chunk, opts);
    }
    await this.appendColdStartProgress(key);
    logger.info(`[MemoryPlugin] Full history extract completed for groupId=${groupId} userId=${userId} chunks=${chunks.length}`);
  }

  @Hook({
    stage: 'onMessageComplete',
    priority: 'NORMAL',
    order: 15,
  })
  onMessageComplete(context: HookContext): HookResult {
    if (!this.enabled || this.groupIds.size === 0) {
      return true;
    }
    const messageType = context.message?.messageType;
    const groupId = context.message?.groupId?.toString();
    if (messageType !== 'group' || !groupId || !this.groupIds.has(groupId)) {
      return true;
    }
    // Debounce: reset timer for this group; extract runs after debounceMs of no new messages
    this.scheduleExtract(groupId);
    return true;
  }
}

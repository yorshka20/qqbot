// Memory Trigger Plugin - on trigger phrase (e.g. bot name), update user memory then send standalone "记忆已更新" after update completes

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { type ConversationHistoryService, normalizeGroupId } from '@/conversation/history';
import {
  buildConversationWindowDocument,
  groupEntriesIntoWindows,
} from '@/conversation/rag/buildConversationWindowDocument';
import { isNoReplyPath } from '@/context/HookContextHelpers';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import type { MemoryExtractService } from '@/memory';
import type { MemoryService } from '@/memory/MemoryService';
import type { RetrievalService } from '@/services/retrieval';
import { QdrantClient } from '@/services/retrieval';
import type { RAGDocument } from '@/services/retrieval/rag/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';
import type { PluginManager } from '../PluginManager';
import type { MemoryPlugin } from './MemoryPlugin';

export interface MemoryTriggerPluginConfig {
  /** Group IDs where trigger-to-remember is enabled (should match memory-enabled groups). */
  groups?: string[];
  /** Bot name or trigger phrase at start of message (e.g. "cygnus"). Case-insensitive match after trim. */
  triggerName?: string;
  /** Optional: only treat as "remember" when message also contains one of these (e.g. ["记住", "请记住"]). */
  triggerKeywords?: string[];
  /** Run RAG cold start (backfill existing history to Qdrant) when trigger is first used in a group. Default true. */
  coldStartOnTrigger?: boolean;
  /** Max messages to backfill per group on cold start. 0 = all messages in DB (full backfill); >0 = cap. Default 0. */
  coldStartMaxMessages?: number;
  /** Batch size for cold start upsert. Default 40. */
  coldStartBatchSize?: number;
  /** Progress file for RAG cold start (one groupId per line). Default "data/rag_cold_start_groups.txt". */
  coldStartProgressFile?: string;
  /** Checkpoint file for resume (groupId -> lastInsertedCount). Default "data/rag_cold_start_checkpoint.json". */
  coldStartCheckpointFile?: string;
}

/** 0 = no limit (full DB backfill); >0 = cap for testing or large groups. */
const DEFAULT_COLD_START_MAX_MESSAGES = 0;
const DEFAULT_COLD_START_PROGRESS_FILE = 'data/rag_cold_start_groups.txt';
const DEFAULT_COLD_START_CHECKPOINT_FILE = 'data/rag_cold_start_checkpoint.json';
const DEFAULT_COLD_START_BATCH_SIZE = 40;
/** Window params for cold start (same as RAGPersistenceSystem): idle minutes, max messages per window. */
const COLD_START_WINDOW_IDLE_MINUTES = 5;
const COLD_START_WINDOW_MAX_MESSAGES = 10;

@RegisterPlugin({
  name: 'memoryTrigger',
  version: '1.0.0',
  description:
    'Memory trigger: on trigger phrase (e.g. bot name), write user message as user memory and continue to reply',
})
export class MemoryTriggerPlugin extends PluginBase {
  private groupIds = new Set<string>();
  private triggerName = '';
  private triggerKeywords: string[] = [];
  private coldStartOnTrigger = true;
  private coldStartMaxMessages = DEFAULT_COLD_START_MAX_MESSAGES;
  private coldStartBatchSize = DEFAULT_COLD_START_BATCH_SIZE;
  private coldStartProgressFile = DEFAULT_COLD_START_PROGRESS_FILE;
  private coldStartCheckpointFile = DEFAULT_COLD_START_CHECKPOINT_FILE;
  /** Group IDs that have already run RAG cold start (loaded from file + in-memory; avoid duplicate trigger). */
  private coldStartedGroupIds = new Set<string>();
  /** Group IDs currently running cold start (avoid concurrent duplicate run for same group). */
  private pendingColdStartGroupIds = new Set<string>();

  private memoryService!: MemoryService;
  private memoryExtractService!: MemoryExtractService;
  private pluginManager!: PluginManager;
  private messageAPI!: MessageAPI;
  private retrievalService!: RetrievalService | null;
  private conversationHistoryService!: ConversationHistoryService;

  async onInit(): Promise<void> {
    this.enabled = true;
    const container = getContainer();
    this.memoryService = container.resolve<MemoryService>(DITokens.MEMORY_SERVICE);
    this.memoryExtractService = container.resolve<MemoryExtractService>(DITokens.MEMORY_EXTRACT_SERVICE);
    this.pluginManager = container.resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
    this.conversationHistoryService = container.resolve<ConversationHistoryService>(
      DITokens.CONVERSATION_HISTORY_SERVICE,
    );
    this.retrievalService = container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);

    const pluginConfig = this.pluginConfig?.config as MemoryTriggerPluginConfig | undefined;
    if (pluginConfig?.groups?.length) {
      this.groupIds = new Set(pluginConfig.groups);
      this.triggerName = (pluginConfig.triggerName ?? '').trim();
      this.triggerKeywords = Array.isArray(pluginConfig.triggerKeywords) ? pluginConfig.triggerKeywords : [];
      this.coldStartOnTrigger = pluginConfig.coldStartOnTrigger ?? true;
      this.coldStartMaxMessages = pluginConfig.coldStartMaxMessages ?? DEFAULT_COLD_START_MAX_MESSAGES;
      this.coldStartBatchSize = pluginConfig.coldStartBatchSize ?? DEFAULT_COLD_START_BATCH_SIZE;
      this.coldStartProgressFile = pluginConfig.coldStartProgressFile ?? DEFAULT_COLD_START_PROGRESS_FILE;
      this.coldStartCheckpointFile = pluginConfig.coldStartCheckpointFile ?? DEFAULT_COLD_START_CHECKPOINT_FILE;
      if (this.coldStartOnTrigger) {
        this.coldStartedGroupIds = await this.loadColdStartProgress();
        logger.debug(
          `[MemoryTriggerPlugin] RAG cold start progress loaded: ${this.coldStartedGroupIds.size} group(s) already done`,
        );
      }
      logger.info(
        `[MemoryTriggerPlugin] Enabled for groups: ${Array.from(this.groupIds).join(', ')} triggerName=${this.triggerName} coldStartOnTrigger=${this.coldStartOnTrigger}`,
      );
      // TODO remove after test: run RAG cold start for this group on boot
      // void this.runRAGColdStartForGroup('');
    }
  }

  private getColdStartProgressPath(): string {
    return join(process.cwd(), this.coldStartProgressFile);
  }

  /** Load set of groupIds that have already completed RAG cold start (persisted to file). */
  private async loadColdStartProgress(): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const path = this.getColdStartProgressPath();
      const content = await readFile(path, 'utf-8');
      for (const line of content.split('\n')) {
        const id = line.trim();
        if (id) {
          set.add(id);
        }
      }
    } catch {
      // File may not exist yet
    }
    return set;
  }

  /** Append groupId to cold start progress file so we do not re-trigger after restart. */
  private async appendColdStartProgress(groupId: string): Promise<void> {
    try {
      const path = this.getColdStartProgressPath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${groupId}\n`);
    } catch (err) {
      logger.warn('[MemoryTriggerPlugin] Failed to append cold start progress:', err);
    }
  }

  /** Load checkpoint: groupId -> number of window docs already upserted. Version 2 = windowed; old format ignored. */
  private async loadColdStartCheckpoint(): Promise<Record<string, number>> {
    try {
      const path = join(process.cwd(), this.coldStartCheckpointFile);
      const content = await readFile(path, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      if (typeof data !== 'object' || data === null) {
        return {};
      }
      const out: Record<string, number> = {};
      for (const k of Object.keys(data)) {
        if (k === '_v') {
          continue;
        }
        const v = data[k];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
          out[k] = v;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Write checkpoint so we can resume after restart (version 2 = windowed). */
  private async saveColdStartCheckpoint(checkpoint: Record<string, number>): Promise<void> {
    try {
      const path = join(process.cwd(), this.coldStartCheckpointFile);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(checkpoint, null, 0), 'utf-8');
    } catch (err) {
      logger.warn('[MemoryTriggerPlugin] Failed to save cold start checkpoint:', err);
    }
  }

  /**
   * Check if message is a "remember" trigger: starts with triggerName (or contains triggerKeyword) and has content after it.
   */
  private isTriggerMessage(message: string): boolean {
    const raw = (message ?? '').trim();
    if (!raw) {
      return false;
    }
    if (this.triggerName) {
      const lower = raw.toLowerCase();
      const name = this.triggerName.toLowerCase();
      if (lower.startsWith(name)) {
        const after = raw.slice(this.triggerName.length).trim();
        if (after.length > 0) {
          return true;
        }
      }
    }
    if (this.triggerKeywords.length > 0 && this.triggerKeywords.some((k) => raw.includes(k))) {
      return true;
    }
    return false;
  }

  /**
   * Extract content to remember: strip trigger name (and optional comma/space) from start.
   */
  private extractContentToRemember(message: string): string {
    let rest = (message ?? '').trim();
    if (this.triggerName) {
      const lower = rest.toLowerCase();
      const name = this.triggerName.toLowerCase();
      if (lower.startsWith(name)) {
        rest = rest
          .slice(this.triggerName.length)
          .replace(/^[\s,，、]+/, '')
          .trim();
      }
    }
    return rest;
  }

  /**
   * RAG cold start: backfill existing conversation history for the group to Qdrant using time-windowed points
   * (same as RAGPersistenceSystem: 5 min idle or 10 messages per window, speaker-prefixed content).
   * Supports resume: checkpoint (groupId -> windows already upserted) is written after each batch.
   * Completed groups are in coldStartedGroupIds + progress file and are skipped.
   */
  private async runRAGColdStartForGroup(groupId: string): Promise<void> {
    if (!this.coldStartOnTrigger || !this.retrievalService?.isRAGEnabled()) {
      return;
    }
    if (this.coldStartedGroupIds.has(groupId)) {
      return;
    }
    if (this.pendingColdStartGroupIds.has(groupId)) {
      return;
    }
    this.pendingColdStartGroupIds.add(groupId);
    try {
      const checkpoint = await this.loadColdStartCheckpoint();
      const windowsCompleted = checkpoint[groupId] ?? 0;

      const limit = this.coldStartMaxMessages === 0 ? 0 : this.coldStartMaxMessages;
      logger.info(
        `[MemoryTriggerPlugin] RAG cold start groupId=${groupId} limit=${limit === 0 ? 'all' : limit} resumeFromWindows=${windowsCompleted}`,
      );
      const entries = await this.conversationHistoryService.getRecentMessages(groupId, limit);
      if (entries.length === 0) {
        this.coldStartedGroupIds.add(groupId);
        await this.appendColdStartProgress(groupId);
        delete checkpoint[groupId];
        await this.saveColdStartCheckpoint(checkpoint);
        return;
      }

      const windows = groupEntriesIntoWindows(entries, COLD_START_WINDOW_IDLE_MINUTES, COLD_START_WINDOW_MAX_MESSAGES);
      const { sessionId, groupIdNum } = normalizeGroupId(groupId);
      const collectionName = QdrantClient.getConversationHistoryCollectionName(
        sessionId,
        'group',
        groupIdNum,
        undefined,
      );
      const documents: RAGDocument[] = windows.map((win) =>
        buildConversationWindowDocument(win, sessionId, 'group', groupIdNum),
      );

      if (windowsCompleted >= documents.length) {
        logger.info(
          `[MemoryTriggerPlugin] RAG cold start groupId=${groupId} already done (windowsCompleted=${windowsCompleted} >= total=${documents.length}), marking complete`,
        );
        this.coldStartedGroupIds.add(groupId);
        await this.appendColdStartProgress(groupId);
        delete checkpoint[groupId];
        await this.saveColdStartCheckpoint(checkpoint);
        return;
      }

      const remaining = documents.slice(windowsCompleted);
      const batchSize = Math.max(1, this.coldStartBatchSize);
      const totalBatches = Math.ceil(remaining.length / batchSize);
      const startMs = Date.now();
      for (let i = 0; i < remaining.length; i += batchSize) {
        const chunk = remaining.slice(i, i + batchSize);
        try {
          await this.retrievalService.upsertDocuments(collectionName, chunk);
          const windowsDoneSoFar = windowsCompleted + i + chunk.length;
          checkpoint[groupId] = windowsDoneSoFar;
          await this.saveColdStartCheckpoint(checkpoint);
          const elapsedMs = Date.now() - startMs;
          const elapsedSec = elapsedMs / 1000;
          const rate = elapsedSec > 0 ? ((i + chunk.length) / elapsedSec).toFixed(1) : '-';
          logger.info(
            `[MemoryTriggerPlugin] RAG cold start progress groupId=${groupId} batch=${Math.floor(i / batchSize) + 1}/${totalBatches} windows=${windowsDoneSoFar}/${documents.length} messages=${entries.length} elapsed=${(elapsedMs / 1000).toFixed(1)}s rate=${rate} win/s`,
          );
        } catch (err) {
          logger.warn(`[MemoryTriggerPlugin] RAG cold start upsert failed groupId=${groupId} batch at ${i}:`, err);
          return;
        }
      }
      const totalElapsedMs = Date.now() - startMs;
      const totalRate = totalElapsedMs > 0 ? ((remaining.length / totalElapsedMs) * 1000).toFixed(1) : '-';
      this.coldStartedGroupIds.add(groupId);
      await this.appendColdStartProgress(groupId);
      delete checkpoint[groupId];
      await this.saveColdStartCheckpoint(checkpoint);
      logger.info(
        `[MemoryTriggerPlugin] RAG cold start completed groupId=${groupId} windows=${documents.length} messages=${entries.length} elapsed=${(totalElapsedMs / 1000).toFixed(1)}s avgRate=${totalRate} win/s`,
      );
    } finally {
      this.pendingColdStartGroupIds.delete(groupId);
    }
  }

  /**
   * Merge new content with existing user memory and upsert.
   * @returns Promise that resolves when update is done (for sending "记忆已更新" after)
   */
  private mergeAndUpsertUserMemory(groupId: string, userId: string, content: string): Promise<void> {
    const existing = this.memoryService.getUserMemoryText(groupId, userId);
    return this.memoryExtractService
      .mergeWithExisting(existing, content, 'user')
      .then((merged) => {
        if (merged) {
          return this.memoryService.upsertMemory(groupId, userId, false, merged);
        }
      })
      .then(() => {
        logger.debug(`[MemoryTriggerPlugin] Merged and updated user memory for group=${groupId} user=${userId}`);
      })
      .catch((err) => {
        logger.warn('[MemoryTriggerPlugin] merge/upsert failed:', err);
      });
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 25,
  })
  onMessagePreprocess(context: HookContext): boolean {
    if (!this.enabled || this.groupIds.size === 0 || !this.memoryService) {
      return true;
    }
    // Whitelist is highest constraint: never respond in non-whitelist groups
    if (isNoReplyPath(context)) {
      return true;
    }
    const sessionType = context.metadata.get('sessionType');
    const groupId = context.message?.groupId?.toString();
    if (sessionType !== 'group' || !groupId || !this.groupIds.has(groupId)) {
      return true;
    }
    const message = context.message?.message ?? '';
    if (!this.isTriggerMessage(message)) {
      return true;
    }
    const content = this.extractContentToRemember(message);
    if (!content) {
      return true;
    }
    const userId = context.message?.userId?.toString();
    if (!userId) {
      return true;
    }
    // When update finishes, send standalone "记忆已更新" (current message may or may not get pipeline reply)
    const sendContext = context.message;
    this.mergeAndUpsertUserMemory(groupId, userId, content)
      .then(() => {
        return this.messageAPI.sendFromContext(`用户 ${userId} 的记忆已更新。`, sendContext, 10000);
      })
      .then(() => {
        logger.debug(`[MemoryTriggerPlugin] Sent "记忆已更新" for group=${groupId} user=${userId}`);
      })
      .catch((err) => {
        logger.warn('[MemoryTriggerPlugin] send "记忆已更新" failed:', err);
      });
    // Schedule full-history extract for this user; runs in same queue as normal extract (queued if extract already running)
    const memoryPlugin = this.pluginManager.getPluginAs<MemoryPlugin>('memory');
    if (memoryPlugin) {
      memoryPlugin.runFullHistoryExtractForUser(groupId, userId);
    }
    // RAG cold start: backfill existing history to Qdrant once per group (fire-and-forget)
    if (this.coldStartOnTrigger && this.retrievalService?.isRAGEnabled()) {
      void this.runRAGColdStartForGroup(groupId).catch((err) => {
        logger.warn('[MemoryTriggerPlugin] RAG cold start failed:', err);
      });
    }
    return true;
  }
}

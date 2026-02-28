// RAG Persistence System - buffers messages per session and writes time-windowed points to Qdrant at COMPLETE stage

import { getReply } from '@/context/HookContextHelpers';
import { buildConversationWindowDocument } from '@/conversation/rag/buildConversationWindowDocument';
import type { ConversationMessageEntry } from '@/conversation/history';
import type { RAGConfig } from '@/core/config/rag';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { HookContext } from '@/hooks/types';
import type { RetrievalService } from '@/retrieval';
import { QdrantClient } from '@/retrieval';
import type { RAGDocument } from '@/retrieval/rag/types';
import { logger } from '@/utils/logger';

/** Default idle minutes to close a conversation window. */
const DEFAULT_WINDOW_IDLE_MINUTES = 5;
/** Default max messages per window. */
const DEFAULT_WINDOW_MAX_MESSAGES = 10;

/**
 * RAG Persistence System
 * At COMPLETE stage, appends user message and (if present) bot reply to a per-session buffer.
 * When the buffer exceeds idle time (e.g. 5 min) or message count (e.g. 10), flushes one window document to Qdrant.
 * Content uses speaker label only (no date/User prefix). Failures are logged and do not interrupt the lifecycle.
 */
export class RAGPersistenceSystem implements System {
  readonly name = 'rag-persistence';
  readonly version = '1.0.0';
  readonly stage = SystemStage.COMPLETE;
  readonly priority = SystemPriority.RAGPersistence;

  /** Per-collection buffer of entries not yet flushed. Key = collection name. */
  private readonly bufferByCollection = new Map<string, ConversationMessageEntry[]>();

  /** Session metadata per collection so we can build window payload on flush. Key = collection name. */
  private readonly sessionMetaByCollection = new Map<
    string,
    { sessionId: string; sessionType: string; groupId?: number }
  >();

  constructor(
    private retrievalService: RetrievalService,
    private ragConfig?: RAGConfig,
  ) {}

  private getWindowIdleMinutes(): number {
    return this.ragConfig?.conversationWindowIdleMinutes ?? DEFAULT_WINDOW_IDLE_MINUTES;
  }

  private getWindowMaxMessages(): number {
    return this.ragConfig?.conversationWindowMaxMessages ?? DEFAULT_WINDOW_MAX_MESSAGES;
  }

  enabled(): boolean {
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    if (!this.retrievalService.isRAGEnabled()) {
      return true;
    }

    const sessionId = context.metadata.get('sessionId') as string | undefined;
    const sessionType = context.metadata.get('sessionType') as string | undefined;
    if (!sessionId || !sessionType) {
      return true;
    }

    const message = context.message;
    const groupId = Number(message?.groupId);
    const userId = Number(message?.userId);
    const collectionName = QdrantClient.getConversationHistoryCollectionName(
      sessionId,
      sessionType,
      Number.isFinite(groupId) ? groupId : undefined,
      Number.isFinite(userId) ? userId : undefined,
    );

    const now = new Date();
    const userMsgId = message.id;
    const replyOnly = context.metadata.get('replyOnly') === true;

    const currentEntries: ConversationMessageEntry[] = [];

    if (!replyOnly) {
      currentEntries.push({
        messageId: userMsgId,
        userId,
        nickname: message?.sender?.nickname,
        content: message?.message ?? '',
        isBotReply: false,
        createdAt: now,
      });
    }

    const reply = getReply(context);
    if (reply != null && reply.trim() !== '') {
      currentEntries.push({
        messageId: `${userMsgId}:reply`,
        userId: 0,
        content: reply.trim(),
        isBotReply: true,
        createdAt: now,
      });
    }

    if (currentEntries.length === 0) {
      return true;
    }

    let buffer = this.bufferByCollection.get(collectionName);
    if (!buffer) {
      buffer = [];
      this.bufferByCollection.set(collectionName, buffer);
      this.sessionMetaByCollection.set(collectionName, {
        sessionId,
        sessionType,
        groupId: Number.isFinite(groupId) ? groupId : undefined,
      });
    }

    const meta = this.sessionMetaByCollection.get(collectionName);
    if (!meta) {
      return true;
    }
    const idleMs = this.getWindowIdleMinutes() * 60 * 1000;
    const maxMessages = this.getWindowMaxMessages();

    if (buffer.length > 0) {
      const firstTime = buffer[0].createdAt instanceof Date ? buffer[0].createdAt : new Date(buffer[0].createdAt);
      const shouldFlush = now.getTime() - firstTime.getTime() >= idleMs || buffer.length >= maxMessages;
      if (shouldFlush) {
        const windowDoc: RAGDocument = buildConversationWindowDocument(
          buffer,
          meta.sessionId,
          meta.sessionType,
          meta.groupId,
        );
        try {
          await this.retrievalService.upsertDocuments(collectionName, [windowDoc]);
          logger.debug(
            `[RAGPersistenceSystem] Flushed window (${buffer.length} entries) to collection=${collectionName}`,
          );
        } catch (error) {
          const err = error instanceof Error ? error : new Error('Unknown error');
          logger.error('[RAGPersistenceSystem] Failed to flush window to Qdrant:', err);
        }
        buffer.length = 0;
      }
    }

    for (const e of currentEntries) {
      buffer.push(e);
    }

    return true;
  }
}

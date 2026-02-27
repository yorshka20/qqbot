// RAG Persistence System - writes user message and bot reply to Qdrant (with embedding) at COMPLETE stage

import { getReply } from '@/context/HookContextHelpers';
import type { ConversationMessageEntry } from '@/conversation/history';
import { formatSingleEntryToText } from '@/conversation/history';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { HookContext } from '@/hooks/types';
import type { RetrievalService } from '@/retrieval';
import { QdrantClient } from '@/retrieval';
import type { RAGDocument } from '@/retrieval/rag/types';
import { logger } from '@/utils/logger';

/**
 * RAG Persistence System
 * At COMPLETE stage, writes the user message and (if present) the bot reply to Qdrant as vectorized documents.
 * When context has replyOnly (e.g. reply-only path), writes only the new reply; the old message is not stored.
 * Uses formatSingleEntryToText for stored content (no [id:0] prefix per message).
 * Failures are logged and do not interrupt the lifecycle.
 */
export class RAGPersistenceSystem implements System {
  readonly name = 'rag-persistence';
  readonly version = '1.0.0';
  readonly stage = SystemStage.COMPLETE;
  readonly priority = SystemPriority.RAGPersistence;

  constructor(private retrievalService: RetrievalService) {}

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

    const documents: RAGDocument[] = [];

    if (!replyOnly) {
      const userEntry: ConversationMessageEntry = {
        messageId: userMsgId,
        userId,
        nickname: message?.sender?.nickname,
        content: message?.message ?? '',
        isBotReply: false,
        createdAt: now,
      };
      documents.push({
        id: userMsgId,
        content: formatSingleEntryToText(userEntry),
        payload: {
          sessionId,
          sessionType,
          groupId,
          userId,
          timestamp: now.toISOString(),
          isBotReply: false,
        },
      });
    }

    const reply = getReply(context);
    if (reply != null && reply.trim() !== '') {
      const replyId = `${userMsgId}:reply`;
      const replyEntry: ConversationMessageEntry = {
        messageId: replyId,
        userId: 0,
        content: reply.trim(),
        isBotReply: true,
        createdAt: now,
      };
      documents.push({
        id: replyId,
        content: formatSingleEntryToText(replyEntry),
        payload: {
          sessionId,
          sessionType,
          groupId,
          userId,
          timestamp: now.toISOString(),
          isBotReply: true,
        },
      });
    }

    if (documents.length === 0) {
      return true;
    }

    try {
      await this.retrievalService.upsertDocuments(collectionName, documents);
      logger.debug(`[RAGPersistenceSystem] Upserted ${documents.length} document(s) to collection=${collectionName}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[RAGPersistenceSystem] Failed to upsert to Qdrant:', err);
    }

    return true;
  }
}

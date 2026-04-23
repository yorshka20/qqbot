// Context enrichment stage — memory + RAG retrieval (parallel).

import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { formatMemoryMarkdown } from '@/memory/formatMemoryMarkdown';
import type { MemoryService } from '@/memory/MemoryService';
import type { RetrievalService } from '@/services/retrieval';
import { QdrantClient } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../../prompt/PromptManager';
import { formatRAGConversationContext } from '../../utils/formatRAGConversationContext';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

const RAG_LIMIT = 5;
const RAG_MIN_SCORE = 0.7;
const ALWAYS_SCOPE = ['instruction', 'rule'];

/**
 * Pipeline stage 4: context enrichment.
 * Fetches group/user memory (with RAG-based semantic filtering) and RAG-retrieved
 * conversation context in parallel. Also exposes {@link getMemoryVarsForReply} for
 * reuse by the NSFW reply path which needs memory but bypasses the full pipeline.
 */
export class ContextEnrichmentStage implements ReplyStage {
  readonly name = 'context-enrichment';

  private config: Config;

  constructor(
    private memoryService: MemoryService,
    private retrievalService: RetrievalService,
    private promptManager: PromptManager,
  ) {
    this.config = getContainer().resolve<Config>(DITokens.CONFIG);
  }

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const [memoryContextText, retrievedConversationSection] = await Promise.all([
      this.getMemoryContextTextAsync(ctx.hookContext),
      this.getRetrievedConversationSection(ctx.hookContext),
    ]);
    ctx.memoryContextText = memoryContextText;
    ctx.retrievedConversationSection = retrievedConversationSection;
  }

  // --- Also used by NSFW path (via orchestrator) ---

  async getMemoryVarsForReply(
    context: HookContext,
  ): Promise<{ groupMemoryText: string; userMemoryText: string; retrievedConversationSection: string }> {
    const [memoryVars, retrievedConversationSection] = await Promise.all([
      this.getMemoryVarsAsync(context),
      this.getRetrievedConversationSection(context),
    ]);
    return { ...memoryVars, retrievedConversationSection };
  }

  // --- Private helpers ---

  private async getRetrievedConversationSection(context: HookContext): Promise<string> {
    if (!this.retrievalService?.isRAGEnabled()) {
      return '';
    }
    const sessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');
    if (!sessionId || !sessionType) {
      return '';
    }
    const collectionName = QdrantClient.getConversationHistoryCollectionName(
      sessionId,
      sessionType,
      context.message?.groupId,
      context.message?.userId,
    );
    const rawMessage = (context.message?.message ?? '').trim();
    if (!rawMessage) {
      return '';
    }
    try {
      const hits = await this.retrievalService.vectorSearch(collectionName, rawMessage, {
        limit: RAG_LIMIT,
        minScore: RAG_MIN_SCORE,
      });
      if (hits.length === 0) {
        return '';
      }
      const formatted = formatRAGConversationContext(hits);
      if (!formatted) {
        return '';
      }
      return this.promptManager.render('rag.conversation_context', {
        retrievedConversationContext: formatted,
      });
    } catch (err) {
      logger.warn('[ContextEnrichmentStage] RAG vectorSearch failed, skipping retrieved section:', err);
      return '';
    }
  }

  private async getMemoryVarsAsync(context: HookContext): Promise<{ groupMemoryText: string; userMemoryText: string }> {
    if (!this.memoryService) {
      return { groupMemoryText: '', userMemoryText: '' };
    }
    const sessionType = context.metadata.get('sessionType');
    const sessionId = context.metadata.get('sessionId');
    if (sessionType !== 'group' || !sessionId.startsWith('group:')) {
      return { groupMemoryText: '', userMemoryText: '' };
    }
    const groupId = sessionId.replace(/^group:/, '');
    const userId = context.message?.userId?.toString() ?? '';
    const userMessage = context.message?.message ?? '';

    const memoryConfig = this.config.getMemoryConfig();
    const filterConfig = memoryConfig.filter;

    if (filterConfig?.enabled === false) {
      return this.memoryService.getMemoryTextForReply(groupId, userId);
    }

    const result = await this.memoryService.getFilteredMemoryForReplyAsync(groupId, userId, {
      userMessage,
      alwaysIncludeScopes: filterConfig?.alwaysIncludeScopes ?? ALWAYS_SCOPE,
      minRelevanceScore: filterConfig?.minRelevanceScore ?? RAG_MIN_SCORE,
      count: RAG_LIMIT,
    });

    return {
      groupMemoryText: result.groupMemoryText,
      userMemoryText: result.userMemoryText,
    };
  }

  private async getMemoryContextTextAsync(context: HookContext): Promise<string> {
    if (!this.memoryService) {
      return '';
    }
    const { groupMemoryText, userMemoryText } = await this.getMemoryVarsAsync(context);

    // The main pipeline only ever has one active speaker per turn, so the
    // user section is at most a single `[speaker:<uid>:<nick>]` block. The
    // multi-speaker case lives in the Live2D pipeline (bilibili danmaku
    // batches); both paths share `formatMemoryMarkdown` to guarantee the
    // same header schema and keep the `<memory_context>` body stable.
    const userId = context.message?.userId?.toString() ?? '';
    const nickname = context.message?.sender?.nickname ?? context.message?.sender?.card ?? '';
    return formatMemoryMarkdown({
      groupMemoryText,
      userSections: userId ? [{ uid: userId, nick: nickname, memoryText: userMemoryText }] : [],
    });
  }
}

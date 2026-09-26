// Context enrichment stage — memory + RAG retrieval (parallel).

import { inject, singleton } from 'tsyringe';
import type { AuditEventStore } from '@/conversation/audit/AuditEventStore';
import type { SessionMemoStore } from '@/conversation/memo/SessionMemoStore';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { formatMemoryMarkdown } from '@/memory/formatMemoryMarkdown';
import { MemoryService } from '@/memory/MemoryService';
import { QdrantClient } from '@/services/retrieval';
import { RetrievalService } from '@/services/retrieval/RetrievalService';
import { VKBContextEngine } from '@/services/vkb/VKBContextEngine';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../../prompt/PromptManager';
import { formatRAGConversationContext } from '../../utils/formatRAGConversationContext';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

const RAG_LIMIT = 5;
const RAG_MIN_SCORE = 0.7;

/**
 * Pipeline stage 4: context enrichment.
 * Fetches group/user memory (with RAG-based semantic filtering) and RAG-retrieved
 * conversation context in parallel. Also exposes {@link getMemoryVarsForReply} for
 * reuse by the NSFW reply path which needs memory but bypasses the full pipeline.
 */
@singleton()
export class ContextEnrichmentStage implements ReplyStage {
  readonly name = 'context-enrichment';

  constructor(
    @inject(MemoryService) private memoryService: MemoryService,
    @inject(RetrievalService) private retrievalService: RetrievalService,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    // No-op when `vkbContextEngine.enabled` is false.
    @inject(VKBContextEngine) private readonly vkbContextEngine: VKBContextEngine,
    @inject(DITokens.AUDIT_EVENT_STORE) private readonly auditEventStore: AuditEventStore,
    @inject(DITokens.SESSION_MEMO_STORE) private readonly sessionMemoStore: SessionMemoStore,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const [memoryContextText, retrievedConversationSection, glossaryText] = await Promise.all([
      this.getMemoryContextTextAsync(ctx.hookContext),
      this.getRetrievedConversationSection(ctx.hookContext),
      this.getGlossary(ctx.hookContext),
    ]);
    ctx.memoryContextText = memoryContextText;
    ctx.retrievedConversationSection = retrievedConversationSection;
    ctx.glossaryText = glossaryText;

    // Recent-action ledger (synchronous in-memory read) — uses the same
    // canonical sessionId the write hook records under (metadata 'sessionId').
    const sessionId = ctx.hookContext.metadata.get('sessionId');
    ctx.recentActionsText = sessionId ? this.auditEventStore.render(sessionId) : '';
    ctx.sessionMemoText = sessionId ? this.sessionMemoStore.render(sessionId) : '';
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

  private async getGlossary(context: HookContext): Promise<string> {
    if (!this.vkbContextEngine.isEnabled()) {
      return '';
    }
    const rawMessage = (context.message?.message ?? '').trim();
    if (!rawMessage) {
      return '';
    }
    // fetchGlossary already swallows errors → empty string. No try/catch needed.
    return this.vkbContextEngine.fetchGlossary(rawMessage);
  }

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
    const sessionType = context.metadata.get('sessionType');
    const sessionId = context.metadata.get('sessionId');
    if (sessionType !== 'group' || !sessionId.startsWith('group:')) {
      return { groupMemoryText: '', userMemoryText: '' };
    }
    const groupId = sessionId.replace(/^group:/, '');
    const userId = context.message?.userId?.toString();
    return this.memoryService.getMemoryForReply(groupId, userId || undefined, context.message?.message ?? '');
  }

  private async getMemoryContextTextAsync(context: HookContext): Promise<string> {
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

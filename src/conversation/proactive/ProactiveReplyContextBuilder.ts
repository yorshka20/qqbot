// Proactive Reply Context Builder - one function per injection type; build methods only assemble

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveReplyInjectContext } from '@/context/types';
import type { ConversationHistoryService, ConversationMessageEntry } from '@/conversation/history';
import type { MemoryService } from '@/memory/MemoryService';
import type { RetrievalService } from '@/retrieval';
import { QdrantClient } from '@/retrieval';
import type { ProactiveThread, ThreadService } from '../thread/ThreadService';
import type { PreferenceKnowledgeService } from './PreferenceKnowledgeService';

export interface ProactiveReplyContextBuilderDeps {
  threadService: ThreadService;
  conversationHistoryService: ConversationHistoryService;
  promptManager: PromptManager;
  preferenceKnowledge: PreferenceKnowledgeService;
  memoryService?: MemoryService;
  /** Optional: for conversation history vector search (RAG over group chat history). */
  retrievalService?: RetrievalService;
  searchLimit: number;
}

/**
 * Each injection type has its own generator; build methods only call these and assemble.
 */
export class ProactiveReplyContextBuilder {
  constructor(private deps: ProactiveReplyContextBuilderDeps) {}

  /** Thread context from existing thread (formatted messages from ThreadService). */
  getThreadContextFormatted(threadId: string): string {
    return this.deps.threadService.getContextFormatted(threadId);
  }

  /** Thread context from raw entries (e.g. new thread before create). */
  getThreadContextFromEntries(entries: ConversationMessageEntry[]): string {
    return this.deps.conversationHistoryService.formatAsText(entries);
  }

  /** Rendered preference (persona) text (e.g. preference.full). */
  getPreferenceText(preferenceKey: string): string {
    return this.deps.promptManager.render(`${preferenceKey}.full`, {});
  }

  /** Retrieved RAG section (## 参考知识 + chunks). */
  async getRetrievedContext(preferenceKey: string, topicOrQuery: string, searchQueries?: string[]): Promise<string> {
    const chunks = await this.deps.preferenceKnowledge.retrieve(preferenceKey, topicOrQuery, {
      limit: this.deps.searchLimit,
      searchQueries,
    });
    return chunks.length ? `## 参考知识\n\n${chunks.join('\n\n')}` : '';
  }

  /**
   * Conversation history RAG section (vector search over group Qdrant collection).
   * When searchQueries is provided (same keywords as SearXNG), runs one vector search per query and merges
   * results (dedupe by id, sort by score) to improve hit rate vs. one long topicOrQuery.
   * Returns empty string when RAG disabled or no retrievalService.
   */
  async getConversationRagSection(groupId: string, topicOrQuery: string, searchQueries?: string[]): Promise<string> {
    if (!this.deps.retrievalService?.isRAGEnabled()) {
      return '';
    }
    // Use group collection (not user_*): proactive reply searches over group chat history, not private chat.
    const collectionName = QdrantClient.getConversationHistoryCollectionName(
      `group:${groupId}`,
      'group',
      Number(groupId),
      undefined,
    );
    const limitPerQuery = 5;
    const minScore = 0.7;
    const maxTotal = 10;

    try {
      let hits: Array<{ id: string | number; score: number; content?: string }>;

      if (searchQueries && searchQueries.length > 0) {
        const byId = new Map<string | number, { id: string | number; score: number; content?: string }>();
        for (const q of searchQueries) {
          const trimmed = q.trim();
          if (!trimmed) {
            continue;
          }
          const results = await this.deps.retrievalService.vectorSearch(collectionName, trimmed, {
            limit: limitPerQuery,
            minScore,
          });
          for (const r of results) {
            const existing = byId.get(r.id);
            if (!existing || r.score > existing.score) {
              byId.set(r.id, { id: r.id, score: r.score, content: r.content });
            }
          }
        }
        hits = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, maxTotal);
      } else {
        hits = await this.deps.retrievalService.vectorSearch(collectionName, topicOrQuery, {
          limit: limitPerQuery,
          minScore,
        });
      }

      if (hits.length === 0) {
        return '';
      }
      const formatted = hits
        .map((r) => r.content ?? '')
        .filter(Boolean)
        .join('\n\n');
      if (!formatted) {
        return '';
      }
      return this.deps.promptManager.render('rag.conversation_context', {
        retrievedConversationContext: formatted,
      });
    } catch {
      return '';
    }
  }

  /** Group + optional user memory section (## 关于本群的记忆 / ## 关于当前发言用户的记忆). */
  getMemoryContext(groupId: string, userId?: string): string {
    if (!this.deps.memoryService) {
      return '';
    }
    const { groupMemoryText, userMemoryText } = this.deps.memoryService.getMemoryTextForReply(groupId, userId);
    const parts: string[] = [];
    if (groupMemoryText) {
      parts.push(`## 关于本群的记忆\n\n${groupMemoryText}`);
    }
    if (userMemoryText) {
      parts.push(`## 关于当前发言用户的记忆\n\n${userMemoryText}`);
    }
    return parts.join('\n\n');
  }

  /**
   * Assemble inject context for replying in an existing thread.
   * @param threadId - Active thread id.
   * @param thread - Thread with messages and groupId.
   * @param preferenceKey - Preference (persona) key for this group.
   * @param topicOrQuery - Topic or query from analysis.
   * @param searchQueries - Optional RAG search queries from analysis.
   * @param triggerUserId - User ID of the message that triggered this reply (from upstream). Used for injecting that user's memory.
   */
  async buildForExistingThread(
    threadId: string,
    thread: ProactiveThread,
    preferenceKey: string,
    topicOrQuery: string,
    searchQueries?: string[],
    triggerUserId?: string,
  ): Promise<ProactiveReplyInjectContext> {
    const threadContext = this.getThreadContextFormatted(threadId);
    const preferenceText = this.getPreferenceText(preferenceKey);
    const retrievedContext = await this.getRetrievedContext(preferenceKey, topicOrQuery, searchQueries);
    const retrievedConversationSection = await this.getConversationRagSection(
      thread.groupId,
      topicOrQuery,
      searchQueries,
    );
    const memoryContext = this.getMemoryContext(thread.groupId, triggerUserId);
    return {
      preferenceText,
      threadContext,
      retrievedContext,
      retrievedConversationSection,
      memoryContext,
      sessionId: thread.groupId,
    };
  }

  /**
   * Assemble inject context for replying to a new thread.
   * @param groupId - Group id.
   * @param preferenceKey - Preference (persona) key for this group.
   * @param topicOrQuery - Topic or query from analysis.
   * @param filteredEntries - Recent group messages (readable only) for thread context.
   * @param searchQueries - Optional RAG search queries from analysis.
   * @param triggerUserId - User ID of the message that triggered this reply (from upstream). Used for injecting that user's memory.
   */
  async buildForNewThread(
    groupId: string,
    preferenceKey: string,
    topicOrQuery: string,
    filteredEntries: ConversationMessageEntry[],
    searchQueries?: string[],
    triggerUserId?: string,
  ): Promise<ProactiveReplyInjectContext> {
    const threadContext = this.getThreadContextFromEntries(filteredEntries);
    const preferenceText = this.getPreferenceText(preferenceKey);
    const retrievedContext = await this.getRetrievedContext(preferenceKey, topicOrQuery, searchQueries);
    const retrievedConversationSection = await this.getConversationRagSection(groupId, topicOrQuery, searchQueries);
    const memoryContext = this.getMemoryContext(groupId, triggerUserId);
    return {
      preferenceText,
      threadContext,
      retrievedContext,
      retrievedConversationSection,
      memoryContext,
      sessionId: groupId,
    };
  }
}

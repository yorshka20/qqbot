// Proactive Reply Context Builder - one function per injection type; build methods only assemble

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { formatRAGConversationContext } from '@/ai/utils/formatRAGConversationContext';
import type { ProactiveReplyInjectContext } from '@/context/types';
import {
  type ConversationHistoryService,
  type ConversationMessageEntry,
  normalizeGroupId,
} from '@/conversation/history';
import type { MemoryService } from '@/memory/MemoryService';
import type { RetrievalService } from '@/services/retrieval';
import { QdrantClient } from '@/services/retrieval';
import type { FetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';
import type { ProactiveThread, ThreadService } from '../thread/ThreadService';
import type { PreferenceKnowledgeService } from './PreferenceKnowledgeService';

/** Max history entries in proactive prompt; when exceeded, front is summarized and summary becomes stable start (in memory). */
const PROACTIVE_MAX_HISTORY_ENTRIES = 24;

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

  private normalizeStaticBlock(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

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
  async getRetrievedContext(
    preferenceKey: string,
    topicOrQuery: string,
    options?: { searchQueries?: string[]; fetchProgressNotifier?: FetchProgressNotifier },
  ): Promise<string> {
    const chunks = await this.deps.preferenceKnowledge.retrieve(preferenceKey, topicOrQuery, {
      limit: this.deps.searchLimit,
      searchQueries: options?.searchQueries,
      fetchProgressNotifier: options?.fetchProgressNotifier,
    });
    return chunks.length ? `## 参考知识\n\n${chunks.join('\n\n')}` : '';
  }

  /**
   * Conversation history RAG section (vector search over group Qdrant collection).
   * Callers pass the trigger user message (not the analyzed topic) so retrieval matches "history relevant to what the user just said";
   * topic is a fallback when no user text is available. Limit 5 results, each with time and participants.
   */
  async getConversationRagSection(groupId: string, query: string): Promise<string> {
    if (!this.deps.retrievalService?.isRAGEnabled()) {
      return '';
    }
    const q = query.trim();
    if (!q) {
      return '';
    }
    const collectionName = QdrantClient.getConversationHistoryCollectionName(
      `group:${groupId}`,
      'group',
      Number(groupId),
      undefined,
    );
    const limit = 5;
    const minScore = 0.5;

    try {
      const hits = await this.deps.retrievalService.vectorSearch(collectionName, q, {
        limit,
        minScore,
      });

      if (hits.length === 0) {
        return '';
      }
      const formatted = formatRAGConversationContext(hits);
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
      parts.push(`## 关于本群的记忆\n\n${this.normalizeStaticBlock(groupMemoryText)}`);
    }
    if (userMemoryText) {
      parts.push(`## 关于当前发言用户的记忆\n\n${this.normalizeStaticBlock(userMemoryText)}`);
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
    fetchProgressNotifier?: FetchProgressNotifier,
  ): Promise<ProactiveReplyInjectContext> {
    const threadContext = this.getThreadContextFormatted(threadId);
    let historyEntries: ConversationMessageEntry[] = thread.messages.map((m, idx) => ({
      messageId: `thread:${threadId}:${idx}`,
      userId: m.userId,
      nickname: m.nickname,
      content: m.content,
      segments: undefined,
      isBotReply: m.isBotReply,
      createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt),
      wasAtBot: m.wasAtBot,
    }));
    // When over limit, summarize front so summary becomes stable start (in memory); next build sees same start.
    if (historyEntries.length > PROACTIVE_MAX_HISTORY_ENTRIES) {
      const replaced = await this.deps.conversationHistoryService.replaceOldestWithSummary(
        historyEntries,
        PROACTIVE_MAX_HISTORY_ENTRIES,
        new Date(),
      );
      const numToReplace = historyEntries.length - (PROACTIVE_MAX_HISTORY_ENTRIES - 1);
      this.deps.threadService.replaceEarliestWithSummary(threadId, numToReplace, replaced[0].content);
      historyEntries = replaced;
    }
    const preferenceText = this.getPreferenceText(preferenceKey);
    const memoryContext = this.getMemoryContext(thread.groupId, triggerUserId);
    const retrievedContext = await this.getRetrievedContext(preferenceKey, topicOrQuery, {
      searchQueries,
      fetchProgressNotifier,
    });
    // Use trigger user message for RAG (same as reply flow): last user message in thread, fallback to topic
    const lastUserMsg = [...thread.messages].reverse().find((m) => !m.isBotReply);
    const ragQuery = lastUserMsg?.content?.trim() || topicOrQuery;
    const retrievedConversationSection = await this.getConversationRagSection(thread.groupId, ragQuery);
    const lastUserMessage = lastUserMsg?.content?.trim() ?? '';
    return {
      preferenceText,
      threadContext,
      historyEntries,
      retrievedContext,
      retrievedConversationSection,
      memoryContext,
      sessionId: `group:${thread.groupId}`,
      lastUserMessage,
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
    fetchProgressNotifier?: FetchProgressNotifier,
  ): Promise<ProactiveReplyInjectContext> {
    const threadContext = this.getThreadContextFromEntries(filteredEntries);
    const preferenceText = this.getPreferenceText(preferenceKey);
    const memoryContext = this.getMemoryContext(groupId, triggerUserId);
    const retrievedContext = await this.getRetrievedContext(preferenceKey, topicOrQuery, {
      searchQueries,
      fetchProgressNotifier,
    });
    // Use trigger user message for RAG (same as reply flow): last user message in entries, fallback to topic
    const lastUserEntry = [...filteredEntries].reverse().find((e) => !e.isBotReply);
    const ragQuery = lastUserEntry?.content?.trim() || topicOrQuery;
    const retrievedConversationSection = await this.getConversationRagSection(groupId, ragQuery);
    const lastUserMessage = lastUserEntry?.content?.trim() ?? topicOrQuery.trim();
    return {
      preferenceText,
      threadContext,
      historyEntries: filteredEntries,
      retrievedContext,
      retrievedConversationSection,
      memoryContext,
      sessionId: normalizeGroupId(groupId).sessionId,
      lastUserMessage,
    };
  }
}

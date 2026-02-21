// Proactive Reply Context Builder - one function per injection type; build methods only assemble

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveReplyInjectContext } from '@/context/types';
import type { MemoryService } from '@/memory/MemoryService';
import type { GroupHistoryService, GroupMessageEntry } from '../thread/GroupHistoryService';
import type { ProactiveThread, ThreadService } from '../thread/ThreadService';
import type { PreferenceKnowledgeService } from './PreferenceKnowledgeService';

export interface ProactiveReplyContextBuilderDeps {
  threadService: ThreadService;
  groupHistoryService: GroupHistoryService;
  promptManager: PromptManager;
  preferenceKnowledge: PreferenceKnowledgeService;
  memoryService?: MemoryService;
  searchLimit: number;
}

/**
 * Each injection type has its own generator; build methods only call these and assemble.
 */
export class ProactiveReplyContextBuilder {
  constructor(private deps: ProactiveReplyContextBuilderDeps) { }

  /** Thread context from existing thread (formatted messages from ThreadService). */
  getThreadContextFormatted(threadId: string): string {
    return this.deps.threadService.getContextFormatted(threadId);
  }

  /** Thread context from raw entries (e.g. new thread before create). */
  getThreadContextFromEntries(entries: GroupMessageEntry[]): string {
    return this.deps.groupHistoryService.formatAsText(entries);
  }

  /** Rendered preference (persona) text (e.g. preference.full). */
  getPreferenceText(preferenceKey: string): string {
    return this.deps.promptManager.render(`${preferenceKey}.full`, {});
  }

  /** Retrieved RAG section (## 参考知识 + chunks). */
  async getRetrievedContext(
    preferenceKey: string,
    topicOrQuery: string,
    searchQueries?: string[],
  ): Promise<string> {
    const chunks = await this.deps.preferenceKnowledge.retrieve(preferenceKey, topicOrQuery, {
      limit: this.deps.searchLimit,
      searchQueries,
    });
    return chunks.length ? `## 参考知识\n\n${chunks.join('\n\n')}` : '';
  }

  /** Group + optional user memory section (## 关于本群的记忆 / ## 关于当前发言用户的记忆). */
  getMemoryContext(groupId: string, userId?: string): string {
    if (!this.deps.memoryService) {
      return '';
    }
    const { groupMemoryText, userMemoryText } = this.deps.memoryService.getMemoryTextForReply(groupId, userId);
    const parts: string[] = [];
    if (groupMemoryText) {
      parts.push('## 关于本群的记忆\n\n' + groupMemoryText);
    }
    if (userMemoryText) {
      parts.push('## 关于当前发言用户的记忆\n\n' + userMemoryText);
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
    const memoryContext = this.getMemoryContext(thread.groupId, triggerUserId);
    return {
      preferenceText,
      threadContext,
      retrievedContext,
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
    filteredEntries: GroupMessageEntry[],
    searchQueries?: string[],
    triggerUserId?: string,
  ): Promise<ProactiveReplyInjectContext> {
    const threadContext = this.getThreadContextFromEntries(filteredEntries);
    const preferenceText = this.getPreferenceText(preferenceKey);
    const retrievedContext = await this.getRetrievedContext(preferenceKey, topicOrQuery, searchQueries);
    const memoryContext = this.getMemoryContext(groupId, triggerUserId);
    return {
      preferenceText,
      threadContext,
      retrievedContext,
      memoryContext,
      sessionId: groupId,
    };
  }
}

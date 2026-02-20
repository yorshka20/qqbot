// Proactive Conversation Service - orchestrates debounced analysis, Ollama, thread, and proactive reply (Phase 1 + Phase 2 RAG)

import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/PromptManager';
import type { OllamaPreliminaryAnalysisService } from '@/ai/services/OllamaPreliminaryAnalysisService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ProtocolName } from '@/core/config/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import type { GroupHistoryService } from './GroupHistoryService';
import type { PreferenceKnowledgeService } from './PreferenceKnowledgeService';
import type { ProactiveThreadPersistenceService } from './ProactiveThreadPersistenceService';
import type { ThreadContextCompressionService } from './ThreadContextCompressionService';
import type { ThreadService } from './ThreadService';

export interface ProactiveGroupConfig {
  groupId: string;
  preferenceKey: string;
}

const DEBOUNCE_MS = 1_000;
const RECENT_MESSAGES_LIMIT = 30;
/** Phase 5: end thread when no activity in this many ms (e.g. 10 minutes). */
const THREAD_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Proactive Conversation Service (Phase 1)
 * Schedules per-group debounced analysis; when timer fires, runs Ollama and optionally sends a proactive reply.
 */
export class ProactiveConversationService {
  private groupConfig = new Map<string, string>(); // groupId -> preferenceKey
  private timersByGroup = new Map<string, ReturnType<typeof setTimeout>>();
  private preferredProtocol: ProtocolName = 'milky';

  constructor(
    private groupHistoryService: GroupHistoryService,
    private threadService: ThreadService,
    private ollamaAnalysis: OllamaPreliminaryAnalysisService,
    private preferenceKnowledge: PreferenceKnowledgeService,
    private threadPersistence: ProactiveThreadPersistenceService,
    private aiService: AIService,
    private messageAPI: MessageAPI,
    private promptManager: PromptManager,
    private threadCompression?: ThreadContextCompressionService,
  ) { }

  /**
   * Set which groups have proactive analysis enabled and their preference key.
   * Called by the plugin from its config.
   */
  setGroupConfig(groups: ProactiveGroupConfig[]): void {
    this.groupConfig.clear();
    for (const g of groups) {
      this.groupConfig.set(g.groupId, g.preferenceKey);
    }
    logger.info(`[ProactiveConversationService] Group config set: ${groups.length} group(s)`);
  }

  /**
   * Set preferred protocol for sending messages (e.g. from config).
   */
  setPreferredProtocol(protocol: ProtocolName): void {
    this.preferredProtocol = protocol;
  }

  /**
   * Schedule analysis for this group (debounced). Call when a group message is received.
   */
  scheduleForGroup(groupId: string): void {
    if (!this.groupConfig.has(groupId)) return;

    const existing = this.timersByGroup.get(groupId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timersByGroup.delete(groupId);
      void this.runAnalysis(groupId);
    }, DEBOUNCE_MS);

    this.timersByGroup.set(groupId, timer);
  }

  /**
   * Run analysis: load context, call Ollama (single or multi-thread), maybe create/reply in thread and send.
   */
  private async runAnalysis(groupId: string): Promise<void> {
    const preferenceKey = this.groupConfig.get(groupId);
    if (!preferenceKey) return;

    // Phase 5: end threads that have been idle longer than threshold (timeout-based end).
    await this.endTimedOutThreads(groupId);

    const preferenceTemplate = `${preferenceKey}.summary`;
    let preferenceText: string;
    try {
      preferenceText = this.promptManager.render(preferenceTemplate, {});
    } catch (err) {
      logger.warn(`[ProactiveConversationService] Failed to render preference ${preferenceTemplate}:`, err);
      return;
    }

    const groupIdNum = parseInt(groupId, 10);
    if (isNaN(groupIdNum)) {
      logger.warn(`[ProactiveConversationService] Invalid groupId: ${groupId}`);
      return;
    }

    const activeThreads = this.threadService.getActiveThreads(groupId);
    const recentEntries = await this.groupHistoryService.getRecentMessages(groupId, RECENT_MESSAGES_LIMIT);
    const recentMessagesText =
      activeThreads.length > 0
        ? this.groupHistoryService.formatAsTextWithIds(recentEntries)
        : this.groupHistoryService.formatAsText(recentEntries);

    let result: Awaited<ReturnType<typeof this.ollamaAnalysis.analyze>>;
    if (activeThreads.length === 0) {
      result = await this.ollamaAnalysis.analyze(preferenceText, recentMessagesText);
    } else {
      const threadsForAnalysis = activeThreads.map((t) => ({
        threadId: t.threadId,
        preferenceKey: t.preferenceKey,
        contextText: this.threadService.getContextFormatted(t.threadId),
      }));
      result = await this.ollamaAnalysis.analyzeWithThreads(preferenceText, recentMessagesText, threadsForAnalysis);
    }

    logger.debug(`[ProactiveConversationService] Ollama analysis result: ${JSON.stringify(result)}`);

    if (result.threadShouldEndId) {
      const threadToEnd = this.threadService.getThread(result.threadShouldEndId);
      if (threadToEnd) {
        await this.threadPersistence.saveEndedThread(threadToEnd);
      }
      this.threadService.endThread(result.threadShouldEndId);
    }

    if (!result.shouldJoin) {
      logger.debug(`[ProactiveConversationService] Ollama: shouldJoin=false | groupId=${groupId}`);
      this.scheduleThreadCompression(groupId);
      return;
    }

    logger.info(`[ProactiveConversationService] Ollama: shouldJoin=true | groupId=${groupId} | result=${JSON.stringify(result)}`);

    const topicOrQuery = result.topic?.trim() || '';

    const replyInExisting = result.replyInThreadId && this.threadService.getThread(result.replyInThreadId);
    if (replyInExisting && replyInExisting.groupId === groupId) {
      this.threadService.setCurrentThread(groupId, replyInExisting.threadId);
      // Append only the messages that analysis said are relevant to this thread (by index list).
      this.threadService.appendGroupMessages(replyInExisting.threadId, recentEntries, {
        messageIds: result.messageIds,
      });
      await this.replyInThread(
        replyInExisting.threadId,
        groupIdNum,
        replyInExisting.preferenceKey,
        topicOrQuery,
      );
      this.scheduleThreadCompression(groupId);
      return;
    }

    if (result.createNew || activeThreads.length === 0) {
      await this.joinWithNewThread(groupId, groupIdNum, preferenceKey, recentMessagesText, topicOrQuery);
    }
    this.scheduleThreadCompression(groupId);
  }

  /**
   * Schedule async thread context compression for the group (Phase 4).
   * Runs after analysis; does not block reply flow.
   */
  private scheduleThreadCompression(groupId: string): void {
    this.threadCompression?.scheduleCompression(groupId);
  }

  /**
   * Phase 5: End threads that have had no activity for longer than THREAD_IDLE_TIMEOUT_MS.
   * Persist each ended thread before removing from active list.
   */
  private async endTimedOutThreads(groupId: string): Promise<void> {
    const threads = this.threadService.getActiveThreads(groupId);
    const now = Date.now();
    for (const thread of threads) {
      const idleMs = now - thread.lastActivityAt.getTime();
      if (idleMs >= THREAD_IDLE_TIMEOUT_MS) {
        logger.info(
          `[ProactiveConversationService] Ending idle thread | threadId=${thread.threadId} | groupId=${groupId} | idleMs=${idleMs}`,
        );
        await this.threadPersistence.saveEndedThread(thread);
        this.threadService.endThread(thread.threadId);
      }
    }
  }

  private async joinWithNewThread(
    groupId: string,
    groupIdNum: number,
    preferenceKey: string,
    recentMessagesText: string,
    topicOrQuery: string,
  ): Promise<void> {
    // use preference.full for generating proactive reply
    const preferenceText = this.promptManager.render(`${preferenceKey}.full`, {});
    const entries = await this.groupHistoryService.getRecentMessages(groupId, RECENT_MESSAGES_LIMIT);
    const thread = this.threadService.create(groupId, preferenceKey, entries);
    // retrieve context from preference knowledge service
    const retrievedChunks = await this.preferenceKnowledge.retrieve(preferenceKey, topicOrQuery);
    // add extra section to template if retrieved chunks are available
    const retrievedContext = retrievedChunks.length
      ? `## 参考知识\n\n${retrievedChunks.join('\n\n')}`
      : '';
    const replyText = await this.aiService.generateProactiveReply(
      preferenceText,
      recentMessagesText,
      groupId,
      retrievedContext,
    );
    if (!replyText) {
      logger.warn('[ProactiveConversationService] Empty proactive reply');
      return;
    }
    await this.sendGroupMessage(groupIdNum, replyText);
    this.threadService.appendMessage(thread.threadId, {
      userId: 0,
      content: replyText,
      isBotReply: true,
    });
  }

  private async replyInThread(
    threadId: string,
    groupIdNum: number,
    preferenceKey: string,
    topicOrQuery: string,
  ): Promise<void> {
    const thread = this.threadService.getThread(threadId);
    if (!thread) return;
    // Thread context already includes the new message(s); we appended them in runAnalysis when we decided to reply here.
    const contextText = this.threadService.getContextFormatted(threadId);
    // use preference.full for generating proactive reply
    const preferenceText = this.promptManager.render(`${preferenceKey}.full`, {});
    // retrieve context from preference knowledge service
    const retrievedChunks = await this.preferenceKnowledge.retrieve(preferenceKey, topicOrQuery);
    // add extra section to template if retrieved chunks are available
    const retrievedContext = retrievedChunks.length
      ? `## 参考知识\n\n${retrievedChunks.join('\n\n')}`
      : '';
    const replyText = await this.aiService.generateProactiveReply(
      preferenceText,
      contextText,
      thread.groupId,
      retrievedContext,
    );
    if (!replyText) return;
    await this.sendGroupMessage(groupIdNum, replyText);
    this.threadService.appendMessage(threadId, {
      userId: 0,
      content: replyText,
      isBotReply: true,
    });
  }

  private async sendGroupMessage(groupId: number, text: string): Promise<void> {
    const syntheticContext: NormalizedMessageEvent = {
      id: '',
      type: 'message',
      timestamp: Date.now(),
      protocol: this.preferredProtocol,
      userId: 0,
      groupId,
      messageType: 'group',
      message: '',
      segments: [],
    };
    await this.messageAPI.sendFromContext(text, syntheticContext, 10000);
    logger.info(`[ProactiveConversationService] Sent proactive message | groupId=${groupId}`);
  }
}

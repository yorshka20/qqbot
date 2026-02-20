// Proactive Conversation Service - orchestrates debounced analysis, Ollama, thread, and proactive reply (Phase 1 + Phase 2 RAG)

import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/PromptManager';
import type { OllamaPreliminaryAnalysisService } from '@/ai/services/OllamaPreliminaryAnalysisService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ProtocolName } from '@/core/config/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import type { GroupHistoryService } from './GroupHistoryService';
import type { GroupMessageEntry } from './GroupHistoryService';
import type { PreferenceKnowledgeService } from './PreferenceKnowledgeService';
import type { ProactiveThreadPersistenceService } from './ProactiveThreadPersistenceService';
import type { ThreadContextCompressionService } from './ThreadContextCompressionService';
import { isReadableTextForThread, type ThreadService } from './ThreadService';

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
  /** groupId -> preferenceKeys[] (multiple preferences per group). */
  private groupConfig = new Map<string, string[]>();
  /** LLM provider name for preliminary analysis (e.g. "ollama", "doubao"). */
  private analysisProviderName = 'ollama';
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
   * Set which groups have proactive analysis enabled and their preference keys.
   * Same groupId can appear multiple times with different preferenceKey (multiple preferences per group).
   * Called by the plugin from its config.
   */
  setGroupConfig(groups: ProactiveGroupConfig[]): void {
    this.groupConfig.clear();
    for (const g of groups) {
      const list = this.groupConfig.get(g.groupId) ?? [];
      if (!list.includes(g.preferenceKey)) list.push(g.preferenceKey);
      this.groupConfig.set(g.groupId, list);
    }
    const total = this.groupConfig.size;
    const withMulti = [...this.groupConfig.values()].filter((arr) => arr.length > 1).length;
    logger.info(`[ProactiveConversationService] Group config set: ${total} group(s)${withMulti ? `, ${withMulti} with multiple preferences` : ''}`);
  }

  /**
   * Set preferred protocol for sending messages (e.g. from config).
   */
  setPreferredProtocol(protocol: ProtocolName): void {
    this.preferredProtocol = protocol;
  }

  /**
   * Set LLM provider name for preliminary analysis (e.g. "ollama", "doubao"). Called by plugin from config.
   */
  setAnalysisProvider(providerName: string): void {
    this.analysisProviderName = providerName;
  }

  /**
   * Schedule analysis for this group (debounced). Call when a group message is received.
   */
  scheduleForGroup(groupId: string): void {
    const keys = this.groupConfig.get(groupId);
    if (!keys?.length) return;

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
    const preferenceKeys = this.groupConfig.get(groupId);
    if (!preferenceKeys?.length) return;

    // Phase 5: end threads that have been idle longer than threshold (timeout-based end).
    await this.endTimedOutThreads(groupId);

    // Build combined preference text so AI knows all available preferences for this group.
    const preferenceParts: string[] = [];
    try {
      for (const key of preferenceKeys) {
        const summary = this.promptManager.render(`${key}.summary`, {});
        preferenceParts.push(`### ${key}\n${summary}`);
      }
    } catch (err) {
      logger.warn(`[ProactiveConversationService] Failed to render preference summaries:`, err);
      return;
    }
    const preferenceText = preferenceParts.length
      ? preferenceParts.join('\n\n')
      : '';

    const groupIdNum = parseInt(groupId, 10);
    if (isNaN(groupIdNum)) {
      logger.warn(`[ProactiveConversationService] Invalid groupId: ${groupId}`);
      return;
    }

    const activeThreads = this.threadService.getActiveThreads(groupId);
    const recentEntries = await this.groupHistoryService.getRecentMessages(groupId, RECENT_MESSAGES_LIMIT);
    // Filter to readable-only for analysis input (so [Record], [Image]-only etc. are not sent to LLM).
    const filteredEntries = recentEntries.filter((e) => isReadableTextForThread(e.content));
    const recentMessagesText =
      activeThreads.length > 0
        ? this.groupHistoryService.formatAsTextWithIds(filteredEntries)
        : this.groupHistoryService.formatAsText(filteredEntries);

    const analysisOptions = { providerName: this.analysisProviderName };
    let result: Awaited<ReturnType<typeof this.ollamaAnalysis.analyze>>;
    if (activeThreads.length === 0) {
      result = await this.ollamaAnalysis.analyze(preferenceText, recentMessagesText, analysisOptions);
    } else {
      const threadsForAnalysis = activeThreads.map((t) => ({
        threadId: t.threadId,
        preferenceKey: t.preferenceKey,
        contextText: this.threadService.getContextFormatted(t.threadId),
      }));
      result = await this.ollamaAnalysis.analyzeWithThreads(preferenceText, recentMessagesText, threadsForAnalysis, analysisOptions);
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

    // Resolve which preference to use: from reply thread, or from result.preferenceKey for new thread. Must be in configured list.
    let preferenceKey: string;
    const replyInExisting = result.replyInThreadId && this.threadService.getThread(result.replyInThreadId);
    if (replyInExisting && replyInExisting.groupId === groupId) {
      preferenceKey = replyInExisting.preferenceKey;
      if (!preferenceKeys.includes(preferenceKey)) {
        logger.warn(`[ProactiveConversationService] replyInThread preferenceKey not in group config, skipping join | groupId=${groupId} | preferenceKey=${preferenceKey}`);
        this.scheduleThreadCompression(groupId);
        return;
      }
    } else {
      preferenceKey = (result.preferenceKey ?? '').trim();
      if (!preferenceKey || !preferenceKeys.includes(preferenceKey)) {
        logger.warn(`[ProactiveConversationService] preferenceKey not configured for group, skipping join | groupId=${groupId} | preferenceKey=${preferenceKey} | allowed=${preferenceKeys.join(',')}`);
        this.scheduleThreadCompression(groupId);
        return;
      }
    }

    logger.info(`[ProactiveConversationService] Ollama: shouldJoin=true | groupId=${groupId} | preferenceKey=${preferenceKey} | result=${JSON.stringify(result)}`);

    const topicOrQuery = result.topic?.trim() || '';

    if (replyInExisting && replyInExisting.groupId === groupId) {
      this.threadService.setCurrentThread(groupId, replyInExisting.threadId);
      const messageIdsToUse = this.resolveMessageIdsForReply(
        replyInExisting,
        filteredEntries,
        result.messageIds,
      );
      this.threadService.appendGroupMessages(replyInExisting.threadId, filteredEntries, {
        messageIds: messageIdsToUse.length ? messageIdsToUse : undefined,
      });
      await this.replyInThread(
        replyInExisting.threadId,
        groupIdNum,
        preferenceKey,
        topicOrQuery,
      );
      this.scheduleThreadCompression(groupId);
      return;
    }

    if (result.createNew || activeThreads.length === 0) {
      await this.joinWithNewThread(groupId, groupIdNum, preferenceKey, filteredEntries, topicOrQuery);
    }
    this.scheduleThreadCompression(groupId);
  }

  /**
   * Resolve which message indices to append when replying in an existing thread.
   * When analysis returns messageIds, use them. Otherwise append only entries strictly newer than the thread's last message (trigger messages only), so all trigger messages are in context even with multiple consecutive runs.
   */
  private resolveMessageIdsForReply(
    thread: { messages: Array<{ createdAt: Date }>; lastActivityAt: Date },
    filteredEntries: GroupMessageEntry[],
    messageIdsFromAnalysis: string[] | undefined,
  ): string[] {
    if (messageIdsFromAnalysis?.length) {
      return messageIdsFromAnalysis;
    }
    const lastMsg = thread.messages[thread.messages.length - 1];
    const lastTime = lastMsg
      ? new Date(lastMsg.createdAt).getTime()
      : new Date(thread.lastActivityAt).getTime();
    return filteredEntries
      .map((e, i) => ({
        i,
        t: (e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt)).getTime(),
      }))
      .filter(({ t }) => t > lastTime)
      .map(({ i }) => String(i));
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

  /**
   * Create a new thread and send one proactive reply. Uses the same filteredEntries for both thread initial context and LLM prompt (no duplicate fetch).
   */
  private async joinWithNewThread(
    groupId: string,
    groupIdNum: number,
    preferenceKey: string,
    filteredEntries: GroupMessageEntry[],
    topicOrQuery: string,
  ): Promise<void> {
    // use preference.full for generating proactive reply
    const preferenceText = this.promptManager.render(`${preferenceKey}.full`, {});
    const thread = this.threadService.create(groupId, preferenceKey, filteredEntries);
    const threadContextText = this.groupHistoryService.formatAsText(filteredEntries);
    // retrieve context from preference knowledge service
    const retrievedChunks = await this.preferenceKnowledge.retrieve(preferenceKey, topicOrQuery);
    // add extra section to template if retrieved chunks are available
    const retrievedContext = retrievedChunks.length
      ? `## 参考知识\n\n${retrievedChunks.join('\n\n')}`
      : '';
    const replyText = await this.aiService.generateProactiveReply(
      preferenceText,
      threadContextText,
      groupId,
      retrievedContext,
      this.analysisProviderName,
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
      this.analysisProviderName,
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

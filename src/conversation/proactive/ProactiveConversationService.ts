// Proactive Conversation Service - orchestrates debounced analysis, Ollama, thread, and proactive reply (Phase 1 + Phase 2 RAG)

import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { OllamaPreliminaryAnalysisService } from '@/ai/services/OllamaPreliminaryAnalysisService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import type { ProtocolName } from '@/core/config/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MemoryService } from '@/memory/MemoryService';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import type { GroupHistoryService, GroupMessageEntry, ThreadContextCompressionService } from '../thread';
import { isReadableTextForThread, type ThreadService } from '../thread';
import type { PreferenceKnowledgeService } from './PreferenceKnowledgeService';
import { ProactiveReplyContextBuilder } from './ProactiveReplyContextBuilder';
import type { ProactiveThreadPersistenceService } from './ProactiveThreadPersistenceService';

export interface ProactiveGroupConfig {
  groupId: string;
  preferenceKey: string;
}

/** Context for a scheduled analysis run; saved when scheduling (from pipeline message), passed into runAnalysis when timer fires. */
export interface ScheduledAnalysisContext {
  groupId: string;
  /** User ID of the message that triggered this schedule (from MessagePipeline event → plugin → here; for memory injection in new-thread reply). */
  triggerUserId?: string;
  /** Whether this schedule is triggered by idle (no new messages since last compression). */
  idleMode?: boolean;
}

const DEBOUNCE_MS = 1_000;
const RECENT_MESSAGES_LIMIT = 30;
/** Trigger thread compression/clean only after this many new messages accumulated (each run summarizes 10 messages). */
const MESSAGES_PER_COMPRESSION_TRIGGER = 10;
/** Phase 5: end thread when no activity in this many ms (e.g. 10 minutes). */
const THREAD_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
/** Do not end the current thread if it had activity within this window (avoids ending the thread we just replied in). */
const RECENT_ACTIVITY_GRACE_MS = 2 * 60 * 1_000;

/**
 * Proactive Conversation Service (Phase 1)
 * Schedules per-group debounced analysis; when timer fires, runs Ollama and optionally sends a proactive reply.
 * Analysis runs are serialized per group (queued, not skipped) so each run sees prior replies in thread context.
 * Dependencies are injected via DI container (see DITokens).
 */
@injectable()
export class ProactiveConversationService {
  /** groupId -> preferenceKeys[] (multiple preferences per group). */
  private groupConfig = new Map<string, string[]>();
  /** LLM provider name for preliminary analysis (e.g. "ollama", "doubao"). */
  private analysisProviderName = 'ollama';
  private timersByGroup = new Map<string, ReturnType<typeof setTimeout>>();
  private preferredProtocol: ProtocolName = 'milky';
  private searchLimit = 8;
  /** Per-thread reply serialization: in-flight reply promise per threadId; resolved when send + append done (or skip). */
  private replyInProgressByThread = new Map<string, Promise<void>>();
  /** Per-group analysis queue: chained promises so each runAnalysis waits for the previous one to complete, ensuring context includes prior replies. */
  private analysisQueueByGroup = new Map<string, Promise<void>>();
  /** Per-group count of new messages since last compression run; compression runs only when count >= MESSAGES_PER_COMPRESSION_TRIGGER. */
  private newMessageCountByGroup = new Map<string, number>();
  /**
   * Last-reply boundary guard: after a new thread is created and replied to, stores the messageId of the newest
   * user message in filteredEntries at that time. Before creating another new thread, checks whether any new user
   * messages arrived after this boundary; if none, blocks to prevent duplicate cross-thread replies.
   */
  private lastNewThreadBoundaryByGroup = new Map<string, string>();
  /** Builds inject context (thread, preference, RAG, memory) for proactive reply at the context layer. */
  private replyContextBuilder: ProactiveReplyContextBuilder;

  constructor(
    @inject(DITokens.GROUP_HISTORY_SERVICE) private groupHistoryService: GroupHistoryService,
    @inject(DITokens.THREAD_SERVICE) private threadService: ThreadService,
    @inject(DITokens.OLLAMA_PRELIMINARY_ANALYSIS_SERVICE) private ollamaAnalysis: OllamaPreliminaryAnalysisService,
    @inject(DITokens.PREFERENCE_KNOWLEDGE_SERVICE) private preferenceKnowledge: PreferenceKnowledgeService,
    @inject(DITokens.PROACTIVE_THREAD_PERSISTENCE_SERVICE) private threadPersistence: ProactiveThreadPersistenceService,
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.THREAD_CONTEXT_COMPRESSION_SERVICE) private threadCompression: ThreadContextCompressionService,
    @inject(DITokens.MEMORY_SERVICE) private memoryService?: MemoryService,
  ) {
    this.replyContextBuilder = new ProactiveReplyContextBuilder({
      threadService,
      groupHistoryService,
      promptManager,
      preferenceKnowledge,
      memoryService,
      searchLimit: this.searchLimit,
    });
  }

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
    logger.info(
      `[ProactiveConversationService] Group config set: ${total} group(s)${withMulti ? `, ${withMulti} with multiple preferences` : ''}`,
    );
  }

  /**
   * Get preference keys configured for a group (for proactive conversation).
   * Returns empty array if group is not configured or not found.
   */
  getGroupPreferenceKeys(groupId: string): string[] {
    return this.groupConfig.get(groupId) ?? [];
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
   * When the debounce timer fires, the analysis is enqueued (not called directly) so that
   * per-group runs are serialized and each run sees the full result of the previous one.
   * @param triggerUserId - User ID of the message that triggered this schedule; saved on context and passed down to reply (for memory injection).
   */
  scheduleForGroup(groupId: string, triggerUserId?: string, idleMode?: boolean): void {
    const keys = this.groupConfig.get(groupId);
    if (!keys?.length) {
      return;
    }

    const cur = this.newMessageCountByGroup.get(groupId) ?? 0;
    this.newMessageCountByGroup.set(groupId, cur + 1);

    const existing = this.timersByGroup.get(groupId);
    if (existing) {
      clearTimeout(existing);
    }

    const context: ScheduledAnalysisContext = { groupId, triggerUserId, idleMode };
    const timer = setTimeout(() => {
      this.timersByGroup.delete(context.groupId);
      this.enqueueAnalysis(context);
    }, DEBOUNCE_MS);

    this.timersByGroup.set(groupId, timer);
  }

  /**
   * Enqueue an analysis run for a group. Chains onto the existing queue promise so runs execute
   * sequentially: each runAnalysis sees thread context (including bot replies) from the previous run.
   */
  private enqueueAnalysis(context: ScheduledAnalysisContext): void {
    const { groupId } = context;
    const prev = this.analysisQueueByGroup.get(groupId) ?? Promise.resolve();
    const next = prev
      .then(() => this.runAnalysis(context))
      .catch((err) => {
        logger.warn(`[ProactiveConversationService] Analysis queue error | groupId=${groupId}:`, err);
      });
    this.analysisQueueByGroup.set(groupId, next);
  }

  /**
   * Run analysis: load context, call Ollama (single or multi-thread), maybe create/reply in thread and send.
   * Receives context from schedule (includes triggerUserId saved when the message triggered the schedule).
   */
  private async runAnalysis(context: ScheduledAnalysisContext): Promise<void> {
    const { groupId, triggerUserId, idleMode } = context;
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
    const preferenceText = preferenceParts.length ? preferenceParts.join('\n\n') : '';

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

    const analysisOptions = {
      providerName: this.analysisProviderName,
      idleMode,
    };
    let result: Awaited<ReturnType<typeof this.ollamaAnalysis.analyze>>;
    if (activeThreads.length === 0) {
      result = await this.ollamaAnalysis.analyze(preferenceText, recentMessagesText, analysisOptions);
    } else {
      const threadsForAnalysis = activeThreads.map((t) => ({
        threadId: t.threadId,
        preferenceKey: t.preferenceKey,
        contextText: this.threadService.getContextFormatted(t.threadId),
      }));
      result = await this.ollamaAnalysis.analyzeWithThreads(
        preferenceText,
        recentMessagesText,
        threadsForAnalysis,
        analysisOptions,
      );
    }

    logger.debug(`[ProactiveConversationService] Ollama analysis result: ${JSON.stringify(result)}`);

    if (result.threadShouldEndId) {
      const threadToEnd = this.threadService.getThread(result.threadShouldEndId);
      if (threadToEnd) {
        const isCurrentThread = this.threadService.getCurrentThreadId(threadToEnd.groupId) === result.threadShouldEndId;
        const lastActivityAge = Date.now() - threadToEnd.lastActivityAt.getTime();
        if (isCurrentThread && lastActivityAge < RECENT_ACTIVITY_GRACE_MS) {
          logger.debug(
            `[ProactiveConversationService] Skip ending current thread (recent activity ${Math.round(lastActivityAge / 1000)}s ago) | threadId=${result.threadShouldEndId} | groupId=${threadToEnd.groupId}`,
          );
        } else {
          await this.threadPersistence.saveEndedThread(threadToEnd);
          this.threadService.endThread(result.threadShouldEndId);
        }
      } else {
        this.threadService.endThread(result.threadShouldEndId);
      }
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
        logger.warn(
          `[ProactiveConversationService] replyInThread preferenceKey not in group config, skipping join | groupId=${groupId} | preferenceKey=${preferenceKey}`,
        );
        this.scheduleThreadCompression(groupId);
        return;
      }
    } else {
      preferenceKey = (result.preferenceKey ?? '').trim();
      if (!preferenceKey || !preferenceKeys.includes(preferenceKey)) {
        logger.warn(
          `[ProactiveConversationService] preferenceKey not configured for group, skipping join | groupId=${groupId} | preferenceKey=${preferenceKey} | allowed=${preferenceKeys.join(',')}`,
        );
        this.scheduleThreadCompression(groupId);
        return;
      }
    }

    logger.info(
      `[ProactiveConversationService] Ollama: shouldJoin=true | groupId=${groupId} | preferenceKey=${preferenceKey} | result=${JSON.stringify(result)}`,
    );

    const topicOrQuery = result.topic?.trim() || '';

    if (replyInExisting && replyInExisting.groupId === groupId) {
      const threadId = replyInExisting.threadId;
      const previousReplyPromise = this.replyInProgressByThread.get(threadId);
      if (previousReplyPromise) {
        await previousReplyPromise;
      }
      let resolveReplyDone: () => void;
      const replyDonePromise = new Promise<void>((r) => {
        resolveReplyDone = r;
      });
      this.replyInProgressByThread.set(threadId, replyDonePromise);
      try {
        const threadNow = this.threadService.getThread(threadId);
        if (!threadNow) {
          logger.debug(
            `[ProactiveConversationService] Skip reply: thread not found after wait | threadId=${threadId} | groupId=${groupId}`,
          );
          return;
        }
        this.threadService.setCurrentThread(groupId, threadId);
        const messageIdsToUse = this.resolveMessageIdsForReply(replyInExisting, filteredEntries, result.messageIds);
        this.threadService.appendGroupMessages(threadId, filteredEntries, {
          messageIds: messageIdsToUse.length ? messageIdsToUse : undefined,
        });
        await this.replyInThread(threadId, groupIdNum, preferenceKey, topicOrQuery, result.searchQueries, triggerUserId);
      } finally {
        this.replyInProgressByThread.delete(threadId);
        resolveReplyDone!();
      }
      this.scheduleThreadCompression(groupId);
      return;
    }

    if (result.createNew || activeThreads.length === 0) {
      if (this.shouldBlockNewThread(groupId, filteredEntries)) {
        logger.info(
          `[ProactiveConversationService] Blocked new thread creation (no new user messages since last new-thread reply) | groupId=${groupId} | preferenceKey=${preferenceKey}`,
        );
        this.scheduleThreadCompression(groupId);
        return;
      }
      await this.joinWithNewThread(
        groupId,
        groupIdNum,
        preferenceKey,
        filteredEntries,
        topicOrQuery,
        result.searchQueries,
        triggerUserId,
      );
      // Record boundary: newest user message in filteredEntries, so subsequent new-thread attempts
      // are blocked until genuinely new user messages arrive.
      const newestUserEntry = [...filteredEntries].reverse().find((e) => !e.isBotReply);
      if (newestUserEntry?.messageId) {
        this.lastNewThreadBoundaryByGroup.set(groupId, newestUserEntry.messageId);
      }
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
    const lastTime = lastMsg ? new Date(lastMsg.createdAt).getTime() : new Date(thread.lastActivityAt).getTime();
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
   * Runs only after MESSAGES_PER_COMPRESSION_TRIGGER new messages accumulated, to avoid frequent summarize/clean.
   */
  private scheduleThreadCompression(groupId: string): void {
    const count = this.newMessageCountByGroup.get(groupId) ?? 0;
    if (count < MESSAGES_PER_COMPRESSION_TRIGGER) {
      return;
    }
    this.newMessageCountByGroup.set(groupId, 0);
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
   * Last-reply boundary guard: blocks new thread creation when all recent user messages were already
   * present when the previous new-thread reply was sent (i.e. no genuinely new user messages since then).
   * Returns true if new thread creation should be blocked.
   */
  private shouldBlockNewThread(groupId: string, filteredEntries: GroupMessageEntry[]): boolean {
    const boundaryMsgId = this.lastNewThreadBoundaryByGroup.get(groupId);
    if (!boundaryMsgId) {
      return false;
    }

    const boundaryIdx = filteredEntries.findIndex((e) => e.messageId === boundaryMsgId);
    if (boundaryIdx === -1) {
      // Boundary message aged out of the 30-message window; enough new messages arrived to justify allowing.
      return false;
    }

    const newUserMessages = filteredEntries.slice(boundaryIdx + 1).filter((e) => !e.isBotReply);
    return newUserMessages.length === 0;
  }

  /**
   * Create a new thread and send one proactive reply. Uses the same filteredEntries for both thread initial context and LLM prompt (no duplicate fetch).
   * @param triggerUserId - From ScheduledAnalysisContext (message that triggered the schedule); passed from upstream, not derived here.
   */
  private async joinWithNewThread(
    groupId: string,
    groupIdNum: number,
    preferenceKey: string,
    filteredEntries: GroupMessageEntry[],
    topicOrQuery: string,
    searchQueries?: string[],
    triggerUserId?: string,
  ): Promise<void> {
    const thread = this.threadService.create(groupId, preferenceKey, filteredEntries);
    const injectContext = await this.replyContextBuilder.buildForNewThread(
      groupId,
      preferenceKey,
      topicOrQuery,
      filteredEntries,
      searchQueries,
      triggerUserId,
    );
    const replyText = await this.aiService.generateProactiveReply(injectContext, this.analysisProviderName);
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

    logger.debug('[ProactiveConversationService] Join with new thread memoryContext:', { memoryContext: injectContext.memoryContext });
  }

  private async replyInThread(
    threadId: string,
    groupIdNum: number,
    preferenceKey: string,
    topicOrQuery: string,
    searchQueries?: string[],
    triggerUserId?: string,
  ): Promise<void> {
    const thread = this.threadService.getThread(threadId);
    if (!thread) return;
    const injectContext = await this.replyContextBuilder.buildForExistingThread(
      threadId,
      thread,
      preferenceKey,
      topicOrQuery,
      searchQueries,
      triggerUserId,
    );
    const replyText = await this.aiService.generateProactiveReply(injectContext, this.analysisProviderName);
    if (!replyText) return;
    await this.sendGroupMessage(groupIdNum, replyText);
    this.threadService.appendMessage(threadId, {
      userId: 0,
      content: replyText,
      isBotReply: true,
    });

    logger.debug('[ProactiveConversationService] Reply in thread memoryContext:', { memoryContext: injectContext.memoryContext });
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

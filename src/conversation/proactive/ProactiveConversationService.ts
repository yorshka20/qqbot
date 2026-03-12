// Proactive Conversation Service - orchestrates debounced analysis, Ollama, thread, and proactive reply (Phase 1 + Phase 2 RAG)

import { inject, injectable } from 'tsyringe';
import type { AIService } from '@/ai/AIService';
import type { VisionImage } from '@/ai/capabilities/types';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { PreliminaryAnalysisResult, PreliminaryAnalysisService } from '@/ai/services/PreliminaryAnalysisService';
import { extractImagesFromSegmentsAsync } from '@/ai/utils/imageUtils';
import type { MessageAPI, SendMessageResult } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService, ConversationMessageEntry } from '@/conversation/history';
import type { Config } from '@/core/config';
import type { ProtocolName } from '@/core/config/types/protocol';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MemoryService } from '@/memory/MemoryService';
import type { MessageSegment } from '@/message/types';
import type { PluginManager } from '@/plugins/PluginManager';
import type { WhitelistPlugin } from '@/plugins/plugins/WhitelistPlugin';
import { WHITELIST_CAPABILITY } from '@/plugins/plugins/whitelistCapabilities';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import { type FetchProgressNotifier, MessageSendFetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';
import type { ThreadContextCompressionService } from '../thread';
import { isReadableTextForThread, type ProactiveThread, type ThreadService } from '../thread';
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
 * Schedules per-group debounced analysis; when timer fires, runs LLM and optionally sends a proactive reply.
 * Analysis runs are serialized per group (queued, not skipped) so each run sees prior replies in thread context.
 * Dependencies are injected via DI container (see DITokens).
 */
@injectable()
export class ProactiveConversationService {
  /** groupId -> preferenceKeys[] (multiple preferences per group). */
  private groupConfig = new Map<string, string[]>();
  /** LLM provider name for preliminary analysis (e.g. "ollama", "doubao"). */
  private analysisProviderName = 'deepseek';
  private timersByGroup = new Map<string, ReturnType<typeof setTimeout>>();
  private preferredProtocol: ProtocolName = 'milky';
  private searchLimit = 8;
  /** Per-thread reply serialization: in-flight reply promise per threadId; resolved when send + append done (or skip). */
  private replyInProgressByThread = new Map<string, Promise<void>>();
  /** Per-group analysis queue: chained promises so each runAnalysis waits for the previous one to complete, ensuring context includes prior replies. */
  private analysisQueueByGroup = new Map<string, Promise<void>>();
  /**
   * Per-group count of new messages since last compression run; compression runs only when count >= MESSAGES_PER_COMPRESSION_TRIGGER. */
  private newMessageCountByGroup = new Map<string, number>();
  /**
   * Last-reply boundary guard: after a new thread is created and replied to, stores the messageId of the newest
   * user message in filteredEntries at that time. Before creating another new thread, checks whether any new user
   * messages arrived after this boundary; if none, blocks to prevent duplicate cross-thread replies.
   */
  private lastNewThreadBoundaryByGroup = new Map<string, string>();
  /** Builds inject context (thread, preference, RAG, memory) for proactive reply at the context layer. */
  private replyContextBuilder: ProactiveReplyContextBuilder;

  private fetchProgressNotifier: FetchProgressNotifier;

  constructor(
    @inject(DITokens.CONVERSATION_HISTORY_SERVICE) private conversationHistoryService: ConversationHistoryService,
    @inject(DITokens.THREAD_SERVICE) private threadService: ThreadService,
    @inject(DITokens.PRELIMINARY_ANALYSIS_SERVICE) private preliminaryAnalysis: PreliminaryAnalysisService,
    @inject(DITokens.PREFERENCE_KNOWLEDGE_SERVICE) preferenceKnowledge: PreferenceKnowledgeService,
    @inject(DITokens.PROACTIVE_THREAD_PERSISTENCE_SERVICE) private threadPersistence: ProactiveThreadPersistenceService,
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.THREAD_CONTEXT_COMPRESSION_SERVICE) private threadCompression: ThreadContextCompressionService,
    @inject(DITokens.CONFIG) private config: Config,
    @inject(DITokens.MEMORY_SERVICE) memoryService?: MemoryService,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager?: DatabaseManager,
    @inject(DITokens.RETRIEVAL_SERVICE) retrievalService?: RetrievalService,
  ) {
    this.replyContextBuilder = new ProactiveReplyContextBuilder({
      threadService,
      conversationHistoryService,
      promptManager,
      preferenceKnowledge,
      memoryService,
      retrievalService,
      searchLimit: this.searchLimit,
    });
    // singleton instance. replyGenerationService will init it.
    this.fetchProgressNotifier = new MessageSendFetchProgressNotifier(messageAPI);
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
  scheduleForGroup(groupId: string, triggerUserId: string, idleMode?: boolean): void {
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
   * True if the group is allowed to receive proactive messages (whitelist + proactive capability).
   * Used to gate runAnalysis before any LLM calls so we do not waste tokens.
   */
  private groupHasProactiveCapability(groupId: string): boolean {
    const pluginManager = getContainer().resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
    const whitelistPlugin = pluginManager?.getPluginAs<WhitelistPlugin>('whitelist');
    if (!whitelistPlugin) {
      const whitelistConfig = this.config.getPluginConfig('whitelist') as { groupIds?: string[] } | undefined;
      const groupIds = Array.isArray(whitelistConfig?.groupIds) ? whitelistConfig.groupIds : [];
      if (groupIds.length === 0) {
        return true;
      }
      return groupIds.includes(groupId);
    }
    const caps = whitelistPlugin.getGroupCapabilities(groupId);
    if (caps === undefined) {
      return false;
    }
    if (caps.length === 0) {
      return true;
    }
    return caps.includes(WHITELIST_CAPABILITY.proactive);
  }

  /**
   * Run analysis: load context, call Ollama (single or multi-thread), maybe create/reply in thread and send.
   * Receives context from schedule (includes triggerUserId saved when the message triggered the schedule).
   */
  private async runAnalysis(context: ScheduledAnalysisContext): Promise<void> {
    const { groupId, triggerUserId, idleMode } = context;

    // Step 1: Ensure group has proactive config.
    const preferenceKeys = this.groupConfig.get(groupId);
    if (!preferenceKeys?.length) {
      return;
    }

    // Step 1b: Gate on whitelist + proactive capability before any LLM (do not waste tokens).
    if (!this.groupHasProactiveCapability(groupId)) {
      logger.debug(
        `[ProactiveConversationService] Group not allowed for proactive (whitelist/capability), skipping analysis | groupId=${groupId}`,
      );
      return;
    }

    // Step 2: Phase 5 – end threads that have been idle longer than threshold (timeout-based end).
    await this.endTimedOutThreads(groupId);

    // Step 3: Build combined preference text for analysis prompt.
    const preferenceText = this.buildPreferenceText(preferenceKeys);
    if (preferenceText === null) {
      return;
    }

    const groupIdNum = Number(groupId);
    if (Number.isNaN(groupIdNum) || groupIdNum <= 0) {
      logger.warn(`[ProactiveConversationService] Invalid groupId: ${groupId}`);
      return;
    }

    // Step 4: Load recent messages and filter to readable-only for analysis input.
    const activeThreads = this.threadService.getActiveThreads(groupId);
    const recentEntries = await this.conversationHistoryService.getRecentMessages(groupId, RECENT_MESSAGES_LIMIT);
    const filteredEntries = recentEntries.filter((e) => isReadableTextForThread(e.content));
    const recentMessagesText = this.conversationHistoryService.formatAsText(filteredEntries);

    // Step 5: Trigger-user explicit end – if latest message is from current thread's trigger user and says "话题结束", end thread and send confirmation (no AI analysis).
    if (await this.tryEndThreadByTriggerUserRequest(groupId, groupIdNum, filteredEntries)) {
      return;
    }

    // Step 6: Run preliminary analysis (single-thread or multi-thread).
    const result = await this.runPreliminaryAnalysis(preferenceText, recentMessagesText, activeThreads, idleMode);
    logger.debug(`[ProactiveConversationService] Preliminary analysis result: ${JSON.stringify(result)}`);

    // Step 7: Apply AI-requested thread end (result.threadShouldEndId) with grace period for recent activity.
    await this.applyThreadShouldEndFromResult(result);

    // Step 8: If analysis says do not join, schedule compression and exit.
    if (!result.shouldJoin) {
      logger.debug(`[ProactiveConversationService] Preliminary analysis: shouldJoin=false | groupId=${groupId}`);
      this.scheduleThreadCompression(groupId);
      return;
    }

    // Step 9: Resolve preferenceKey and reply target (existing thread or new); validate against group config.
    const resolved = this.resolvePreferenceAndReplyTarget(result, groupId, preferenceKeys);
    if (!resolved) {
      this.scheduleThreadCompression(groupId);
      return;
    }

    // get preferenceKey and replyInExisting
    const { preferenceKey, replyInExisting } = resolved;
    const topic = result.topic?.trim() || '';

    logger.info(
      `[ProactiveConversationService] Analysis: shouldJoin=true | groupId=${groupId} | preferenceKey=${preferenceKey} | result=${JSON.stringify(result)}`,
    );

    // Step 10a: Reply in existing thread.
    if (replyInExisting) {
      await this.executeReplyInExistingThread({
        groupId,
        groupIdNum,
        replyInExisting,
        result,
        filteredEntries,
        triggerUserId,
      });
    } else {
      // Step 10b: Create new thread and reply if result requests it (or no active threads).
      await this.executeCreateNewThreadIfRequested({
        groupId,
        groupIdNum,
        preferenceKey,
        topic,
        result,
        activeThreads,
        filteredEntries,
        triggerUserId,
      });
    }

    this.scheduleThreadCompression(groupId);
  }

  /** Build combined preference text for analysis prompt. Returns null on render error. */
  private buildPreferenceText(preferenceKeys: string[]): string {
    const preferenceParts: string[] = [];
    for (const key of preferenceKeys) {
      const summary = this.promptManager.render(`${key}.summary`);
      preferenceParts.push(`### ${key}\n${summary}`);
    }

    return preferenceParts.length ? preferenceParts.join('\n\n') : '';
  }

  /**
   * If the latest message is from the current thread's trigger user and says "话题结束", end that thread and send confirmation.
   * Returns true if handled (caller should return); false otherwise.
   */
  private async tryEndThreadByTriggerUserRequest(
    groupId: string,
    groupIdNum: number,
    filteredEntries: ConversationMessageEntry[],
  ): Promise<boolean> {
    const lastUserEntry = [...filteredEntries].reverse().find((e) => !e.isBotReply);
    if (!lastUserEntry?.content?.includes('结束') || !lastUserEntry?.content?.includes('话题')) {
      return false;
    }
    const currentThread = this.threadService.getActiveThread(groupId);
    const lastUserIdStr = String(lastUserEntry.userId);
    const adminUserId = this.promptManager.adminUserId;
    if (!currentThread || (currentThread?.triggerUserId !== lastUserIdStr && lastUserIdStr !== adminUserId)) {
      return false;
    }
    const topicLabel = currentThread.lastTopic || '当前';
    await this.threadPersistence.saveEndedThread(currentThread);
    this.threadService.endThread(currentThread.threadId);
    const endMessage = `已结束${topicLabel}thread。`;
    const sendResult = await this.sendGroupMessage(groupIdNum, endMessage);
    await this.conversationHistoryService.appendBotReplyToGroup(groupId, endMessage, {
      messageSeq: sendResult?.message_seq,
    });
    logger.info(
      `[ProactiveConversationService] Thread ended by trigger user (话题结束) | threadId=${currentThread.threadId} | groupId=${groupId} | topic=${topicLabel}`,
    );
    return true;
  }

  /** Run single-thread or multi-thread preliminary analysis. */
  private async runPreliminaryAnalysis(
    preferenceText: string,
    recentMessagesText: string,
    activeThreads: ProactiveThread[],
    idleMode: boolean = false,
  ): Promise<PreliminaryAnalysisResult> {
    const analysisOptions = {
      providerName: this.analysisProviderName,
      idleMode,
    };
    // new thread
    if (activeThreads.length === 0) {
      return this.preliminaryAnalysis.analyze(preferenceText, recentMessagesText, analysisOptions);
    }

    // existing threads
    const threadsForAnalysis = activeThreads.map((t) => ({
      threadId: t.threadId,
      preferenceKey: t.preferenceKey,
      contextText: this.threadService.getContextFormatted(t.threadId),
      triggerUserId: t.triggerUserId,
    }));
    return this.preliminaryAnalysis.analyzeWithThreads(
      preferenceText,
      recentMessagesText,
      threadsForAnalysis,
      analysisOptions,
    );
  }

  /** Apply result.threadShouldEndId: end the thread with grace period for recent activity. */
  private async applyThreadShouldEndFromResult(result: PreliminaryAnalysisResult): Promise<void> {
    if (!result.threadShouldEndId) {
      return;
    }
    const threadToEnd = this.threadService.getThread(result.threadShouldEndId);
    if (threadToEnd) {
      const isCurrentThread = this.threadService.getCurrentThreadId(threadToEnd.groupId) === result.threadShouldEndId;
      const lastActivityAge = Date.now() - threadToEnd.lastActivityAt.getTime();
      if (isCurrentThread && lastActivityAge < RECENT_ACTIVITY_GRACE_MS) {
        logger.debug(
          `[ProactiveConversationService] Skip ending current thread (recent activity ${Math.round(lastActivityAge / 1000)}s ago) | threadId=${result.threadShouldEndId} | groupId=${threadToEnd.groupId}`,
        );
        return;
      }
      await this.threadPersistence.saveEndedThread(threadToEnd);
      this.threadService.endThread(result.threadShouldEndId);
    } else {
      this.threadService.endThread(result.threadShouldEndId);
    }
  }

  /**
   * Resolve preferenceKey and reply target from analysis result. Returns null if preference is invalid for group.
   */
  private resolvePreferenceAndReplyTarget(
    result: PreliminaryAnalysisResult,
    groupId: string,
    preferenceKeys: string[],
  ): { preferenceKey: string; replyInExisting: ProactiveThread | null } | null {
    const replyInExisting = result.replyInThreadId && this.threadService.getThread(result.replyInThreadId);
    if (replyInExisting && replyInExisting.groupId === groupId) {
      const preferenceKey = replyInExisting.preferenceKey;
      if (!preferenceKeys.includes(preferenceKey)) {
        logger.warn(
          `[ProactiveConversationService] replyInThread preferenceKey not in group config, skipping join | groupId=${groupId} | preferenceKey=${preferenceKey}`,
        );
        return null;
      }
      return { preferenceKey, replyInExisting };
    }
    const preferenceKey = (result.preferenceKey ?? '').trim();
    if (!preferenceKey || !preferenceKeys.includes(preferenceKey)) {
      logger.warn(
        `[ProactiveConversationService] preferenceKey not configured for group, skipping join | groupId=${groupId} | preferenceKey=${preferenceKey} | allowed=${preferenceKeys.join(',')}`,
      );
      return null;
    }
    return { preferenceKey, replyInExisting: null };
  }

  /** Reply in an existing thread: wait for prior reply, append messages, generate and send. */
  private async executeReplyInExistingThread(params: {
    groupId: string;
    groupIdNum: number;
    replyInExisting: ProactiveThread;
    result: PreliminaryAnalysisResult;
    filteredEntries: ConversationMessageEntry[];
    triggerUserId?: string;
  }): Promise<void> {
    const { groupId, groupIdNum, replyInExisting, result, filteredEntries, triggerUserId } = params;
    const { threadId, preferenceKey } = replyInExisting;
    const previousReplyPromise = this.replyInProgressByThread.get(threadId);
    if (previousReplyPromise) {
      await previousReplyPromise;
    }
    const topic = result.topic?.trim() || '';

    let resolveReplyDone: () => void = () => {};
    const replyDonePromise = new Promise<void>((r) => (resolveReplyDone = r));
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
      const messageIdsToUse = this.resolveMessageIdsForReply(threadNow, filteredEntries, result.messageIds);
      this.threadService.appendGroupMessages(threadId, filteredEntries, {
        messageIds: messageIdsToUse.length ? messageIdsToUse : undefined,
      });

      await this.replyInThread(
        threadNow,
        groupIdNum,
        preferenceKey,
        topic,
        result.searchQueries,
        triggerUserId,
        filteredEntries,
      );
    } finally {
      this.replyInProgressByThread.delete(threadId);
      resolveReplyDone();
    }
  }

  /** Create new thread and reply if result requests it; otherwise no-op. Updates lastNewThreadBoundary when a thread is created. */
  private async executeCreateNewThreadIfRequested(params: {
    groupId: string;
    groupIdNum: number;
    preferenceKey: string;
    topic: string;
    result: PreliminaryAnalysisResult;
    activeThreads: ProactiveThread[];
    filteredEntries: ConversationMessageEntry[];
    triggerUserId?: string;
  }): Promise<void> {
    const { groupId, groupIdNum, preferenceKey, topic, result, activeThreads, filteredEntries, triggerUserId } = params;
    if (!result.createNew && activeThreads.length > 0) {
      return;
    }
    if (this.shouldBlockNewThread(groupId, filteredEntries)) {
      logger.info(
        `[ProactiveConversationService] Blocked new thread creation (no new user messages since last new-thread reply) | groupId=${groupId} | preferenceKey=${preferenceKey}`,
      );
      return;
    }
    await this.joinWithNewThread(
      groupId,
      groupIdNum,
      preferenceKey,
      filteredEntries,
      topic,
      result.searchQueries,
      triggerUserId,
    );
    const newestUserEntry = [...filteredEntries].reverse().find((e) => !e.isBotReply);
    if (newestUserEntry?.messageId) {
      this.lastNewThreadBoundaryByGroup.set(groupId, newestUserEntry.messageId);
    }
  }

  /**
   * Resolve which message indices to append when replying in an existing thread.
   * When analysis returns messageIds, use them but filter to only indices newer than thread's last message and not bot replies (avoid duplicates).
   * Otherwise append only entries strictly newer than the thread's last message (trigger messages only).
   */
  private resolveMessageIdsForReply(
    thread: { messages: Array<{ createdAt: Date }>; lastActivityAt: Date },
    filteredEntries: ConversationMessageEntry[],
    messageIdsFromAnalysis: string[] | undefined,
  ): string[] {
    const lastMsg = thread.messages[thread.messages.length - 1];
    const lastTime = lastMsg ? new Date(lastMsg.createdAt).getTime() : new Date(thread.lastActivityAt).getTime();

    if (messageIdsFromAnalysis?.length) {
      // Only append entries strictly newer than thread's last message and not bot replies, to avoid duplicating content already in thread.
      return messageIdsFromAnalysis.filter((id) => {
        const i = parseInt(id, 10);
        if (Number.isNaN(i) || i < 0 || i >= filteredEntries.length) return false;
        const e = filteredEntries[i];
        if (e.isBotReply) return false;
        const t = (e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt)).getTime();
        return t > lastTime;
      });
    }

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
  private shouldBlockNewThread(groupId: string, filteredEntries: ConversationMessageEntry[]): boolean {
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
   * If the last user message in filteredEntries had images, load from DB and return VisionImage[] for vision reply.
   * When non-empty, caller sets injectContext.messageImages so generateProactiveReply uses vision provider.
   */
  private async getImagesFromLastUserMessage(
    filteredEntries: ConversationMessageEntry[],
    _groupId: string,
  ): Promise<VisionImage[]> {
    const adapter = this.databaseManager?.getAdapter();
    if (!adapter) {
      return [];
    }
    const lastUserEntry = [...filteredEntries].reverse().find((e) => !e.isBotReply);
    if (!lastUserEntry?.messageId) {
      return [];
    }
    try {
      const messages = adapter.getModel('messages');
      const dbMessage = await messages.findOne({ id: lastUserEntry.messageId } as Partial<Message>);
      if (!dbMessage?.rawContent) {
        return [];
      }
      let segments: Array<{ type: string; data?: unknown }>;
      try {
        segments = JSON.parse(dbMessage.rawContent) as Array<{ type: string; data?: unknown }>;
      } catch {
        return [];
      }
      if (!Array.isArray(segments) || !segments.some((s) => s?.type === 'image')) {
        return [];
      }
      const protocol = dbMessage.protocol as ProtocolName;
      const minimalContext: NormalizedMessageEvent = {
        id: '',
        type: 'message',
        timestamp: 0,
        protocol,
        userId: 0,
        groupId: dbMessage.groupId ?? 0,
        messageType: 'group',
        message: '',
        segments: [],
      };
      const getResourceUrl = (resourceId: string) => this.messageAPI.getResourceTempUrl(resourceId, minimalContext);
      return await extractImagesFromSegmentsAsync(segments as MessageSegment[], getResourceUrl);
    } catch (error) {
      logger.warn(
        '[ProactiveConversationService] getImagesFromLastUserMessage failed:',
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  /**
   * Create a new thread and send one proactive reply. Uses the same filteredEntries for both thread initial context and LLM prompt (no duplicate fetch).
   * @param triggerUserId - From ScheduledAnalysisContext (message that triggered the schedule); passed from upstream, not derived here.
   */
  private async joinWithNewThread(
    groupId: string,
    groupIdNum: number,
    preferenceKey: string,
    filteredEntries: ConversationMessageEntry[],
    topic: string,
    searchQueries?: string[],
    triggerUserId?: string,
  ): Promise<void> {
    const thread = this.threadService.create(groupId, preferenceKey, filteredEntries, triggerUserId, topic);
    const injectContext = await this.replyContextBuilder.buildForNewThread(
      groupId,
      preferenceKey,
      topic,
      filteredEntries,
      searchQueries,
      triggerUserId,
      this.fetchProgressNotifier,
    );
    const messageImages = await this.getImagesFromLastUserMessage(filteredEntries, groupId);
    if (messageImages.length > 0) {
      injectContext.messageImages = messageImages;
    }
    const replyText = await this.aiService.generateProactiveReply(injectContext, this.analysisProviderName);
    if (!replyText) {
      logger.warn('[ProactiveConversationService] Empty proactive reply');
      return;
    }
    // Optionally render as card (same pipeline as ReplyGenerationService); store card text in thread for LLM-readable history
    const cardResult = await this.aiService.processReplyMaybeCard(replyText, groupId, this.analysisProviderName);
    const toSend = cardResult ? cardResult.segments : replyText;
    const toAppend = cardResult ? cardResult.textForHistory : replyText;
    // Update thread and DB before/on send so the next message or analysis run already sees this reply (no need to wait for echo).
    this.threadService.appendMessage(thread.threadId, {
      userId: 0,
      content: toAppend,
      isBotReply: true,
    });
    const sendResult = await this.sendGroupMessage(groupIdNum, toSend);
    await this.conversationHistoryService.appendBotReplyToGroup(groupId, toAppend, {
      messageSeq: sendResult?.message_seq,
    });
  }

  private async replyInThread(
    thread: ProactiveThread,
    groupIdNum: number,
    preferenceKey: string,
    topic: string,
    searchQueries?: string[],
    triggerUserId?: string,
    filteredEntries?: ConversationMessageEntry[],
  ): Promise<void> {
    const injectContext = await this.replyContextBuilder.buildForExistingThread(
      thread.threadId,
      thread,
      preferenceKey,
      topic,
      searchQueries,
      triggerUserId,
      this.fetchProgressNotifier,
    );
    if (filteredEntries?.length) {
      const messageImages = await this.getImagesFromLastUserMessage(filteredEntries, thread.groupId);
      if (messageImages.length > 0) {
        injectContext.messageImages = messageImages;
      }
    }
    const replyText = await this.aiService.generateProactiveReply(injectContext, this.analysisProviderName);
    if (!replyText) {
      logger.warn('[ProactiveConversationService] Empty proactive reply (existing thread)');
      return;
    }

    // Optionally render as card (same pipeline as ReplyGenerationService); store card text in thread for LLM-readable history
    const cardResult = await this.aiService.processReplyMaybeCard(replyText, thread.groupId, this.analysisProviderName);
    const toSend = cardResult ? cardResult.segments : replyText;
    const toAppend = cardResult ? cardResult.textForHistory : replyText;
    // Update thread and DB before/on send so the next message or analysis run already sees this reply (no need to wait for echo).
    this.threadService.appendMessage(thread.threadId, {
      userId: 0,
      content: toAppend,
      isBotReply: true,
    });
    const sendResult = await this.sendGroupMessage(groupIdNum, toSend);
    await this.conversationHistoryService.appendBotReplyToGroup(thread.groupId, toAppend, {
      messageSeq: sendResult?.message_seq,
    });
  }

  private async sendGroupMessage(
    groupId: number,
    message: string | MessageSegment[],
  ): Promise<SendMessageResult | undefined> {
    const groupIdStr = String(groupId);
    // Final guard (primary gate is in runAnalysis before any LLM); skip if config changed mid-run.
    if (!this.groupHasProactiveCapability(groupIdStr)) {
      logger.info(`[ProactiveConversationService] Group not allowed for proactive, skipping send | groupId=${groupId}`);
      return undefined;
    }
    const syntheticContext = this.buildSyntheticGroupContext(groupId);
    const result = await this.messageAPI.sendFromContext(message, syntheticContext, 10000);
    logger.info(`[ProactiveConversationService] Sent proactive message | groupId=${groupId}`);
    return result;
  }

  private buildSyntheticGroupContext(groupId: number): NormalizedMessageEvent {
    return {
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
  }
}

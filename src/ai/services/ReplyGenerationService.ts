// Reply Generation Service - provides AI reply generation capabilities

import type { MessageAPI } from '@/api/methods/MessageAPI';
import { replaceReply, replaceReplyWithSegments, setReplyWithSegments } from '@/context/HookContextHelpers';
import {
  type ConversationHistoryService,
  type ConversationMessageEntry,
  NormalEpisodeService,
  normalizeSessionId,
} from '@/conversation/history';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import type { RetrievalService } from '@/services/retrieval';
import { QdrantClient } from '@/services/retrieval';
import type { TaskResult } from '@/task/types';
import { logger } from '@/utils/logger';
import { type FetchProgressNotifier, MessageSendFetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';
import type { VisionImage } from '../capabilities/types';
import type { PromptManager } from '../prompt/PromptManager';
import { PromptMessageAssembler } from '../prompt/PromptMessageAssembler';
import type { ProviderRouter } from '../routing/ProviderRouter';
import type { AIGenerateResponse, ChatMessage, ContentPart } from '../types';
import { formatRAGConversationContext } from '../utils/formatRAGConversationContext';
import {
  extractImagesFromMessageAndReply,
  extractImagesFromSegmentsAsync,
  getReplyMessageIdFromMessage,
  normalizeVisionImages,
} from '../utils/imageUtils';
import { CardRenderingService } from './CardRenderingService';
import type { LLMService } from './LLMService';
import type { VisionService } from './VisionService';

/**
 * Reply Generation Service
 * Provides AI reply generation capabilities including basic replies, vision support, and task-based replies.
 *
 * Reply paths (all non-NSFW use optional multi-round search via RetrievalService.performRecursiveSearchRefined):
 * - generateReplyFromTaskResults: main entry (TaskSystem / ReplyTaskExecutor); when message has images uses vision provider, else default LLM.
 * - generateNsfwReply: no search (fixed NSFW prompt only).
 */
/** Normal mode: max history entries in prompt (stable size for cache hit). Excludes current user message; when exceeded, oldest are summarized. Initial context window (10 min) is defined in NormalEpisodeService.CONTEXT_WINDOW_MS. */
const NORMAL_MAX_HISTORY_ENTRIES = 24;

/** Provider used only for convert-to-card LLM call (cheap); never use main reply provider (e.g. anthropic). */
const CONVERT_TO_CARD_PROVIDER = 'doubao';

export class ReplyGenerationService {
  private readonly MAX_SEARCH_ITERATIONS = 5;

  private static readonly RAG_LIMIT = 5;
  private static readonly RAG_MIN_SCORE = 0.5;

  /** Single FetchProgressNotifier instance for reply flow; setMessageEvent() before each search. */
  private fetchProgressNotifier: FetchProgressNotifier;

  private readonly episodeService = new NormalEpisodeService();
  private readonly messageAssembler = new PromptMessageAssembler();

  /** Per-episode history cache so prompt prefix stays stable until summary roll (for LLM cache). */
  private readonly episodeHistoryCache = new Map<string, ConversationMessageEntry[]>();

  constructor(
    private llmService: LLMService,
    private visionService: VisionService,
    private cardRenderingService: CardRenderingService,
    private providerRouter: ProviderRouter,
    private promptManager: PromptManager,
    private hookManager: HookManager,
    private conversationHistoryService: ConversationHistoryService,
    private retrievalService: RetrievalService,
    private memoryService: MemoryService,
    private messageAPI: MessageAPI,
    private databaseManager: DatabaseManager,
  ) {
    this.fetchProgressNotifier = new MessageSendFetchProgressNotifier(messageAPI);
  }

  /**
   * Build RAG-retrieved conversation section for prompt injection. Returns empty string when RAG disabled or no hits.
   * Uses the user's full message for a single vector search (no query extraction). Limit 5 results, each with time and participants.
   */
  private async getRetrievedConversationSection(context: HookContext): Promise<string> {
    if (!this.retrievalService?.isRAGEnabled()) {
      return '';
    }
    const sessionId = context.metadata.get('sessionId') as string | undefined;
    const sessionType = context.metadata.get('sessionType') as string | undefined;
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
        limit: ReplyGenerationService.RAG_LIMIT,
        minScore: ReplyGenerationService.RAG_MIN_SCORE,
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
      logger.warn('[ReplyGenerationService] RAG vectorSearch failed, skipping retrieved section:', err);
      return '';
    }
  }

  /**
   * Get memory text vars for prompt (groupMemoryText, userMemoryText). Empty strings when not group or no memory service.
   */
  private getMemoryVars(context: HookContext): { groupMemoryText: string; userMemoryText: string } {
    if (!this.memoryService) {
      return { groupMemoryText: '', userMemoryText: '' };
    }
    const sessionType = context.metadata.get('sessionType');
    const sessionId = context.metadata.get('sessionId') as string | undefined;
    if (sessionType !== 'group' || !sessionId || !sessionId.startsWith('group:')) {
      return { groupMemoryText: '', userMemoryText: '' };
    }
    const groupId = sessionId.replace(/^group:/, '');
    const userId = context.message?.userId?.toString() ?? '';
    return this.memoryService.getMemoryTextForReply(groupId, userId);
  }

  private getMemoryContextText(context: HookContext): string {
    if (!this.memoryService) {
      return '';
    }
    const { groupMemoryText, userMemoryText } = this.getMemoryVars(context);
    return this.promptManager.render('memory.render', {
      groupMemoryText,
      userMemoryText,
    });
  }

  /**
   * Get memory vars for reply (group + user memory text + RAG retrieved conversation section). Used when building reply prompts.
   */
  private async getMemoryVarsForReply(
    context: HookContext,
  ): Promise<{ groupMemoryText: string; userMemoryText: string; retrievedConversationSection: string }> {
    const { groupMemoryText, userMemoryText } = this.getMemoryVars(context);
    const retrievedConversationSection = await this.getRetrievedConversationSection(context);
    return { groupMemoryText, userMemoryText, retrievedConversationSection };
  }

  /**
   * Render task + search segment for reply prompt (like rag.conversation_context). Returns empty string when both are empty.
   */
  private getTaskResultsSummary(taskResults: string): string {
    if (!taskResults) {
      return '';
    }
    return this.promptManager.render('task.result.render', {
      taskResults,
    });
  }

  /**
   * Render search result summary for reply prompt. Returns empty string when no search results.
   */
  private getSearchResultsSummary(searchResults: string): string {
    if (!searchResults) {
      return '';
    }
    return this.promptManager.render('search.result', {
      searchResults,
    });
  }

  /**
   * Generate reply using NSFW-mode prompt template only (fixed reply flow, no task analysis or search).
   * Used when session is in NSFW mode; reply is set to context.reply.
   * Template uses {{char}} (bot's roleplay character) and {{user}} (user's role/name) for narrative RP.
   * Caller may pass options.char and options.instruct (e.g. from /nsfw --char=xxx --instruct=xxx) to fill the prompt template.
   */
  async generateNsfwReply(context: HookContext, options?: { char?: string; instruct?: string }): Promise<void> {
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      const historyText = await this.conversationHistoryService.buildConversationHistory(context);
      const sessionId = context.metadata.get('sessionId');
      const memoryVars = await this.getMemoryVarsForReply(context);

      // char = bot's roleplay character name; instruct = character persona/details (passed by caller, e.g. /nsfw --char=xxx --instruct=xxx); user = user's role/name
      const char = options?.char ?? '';
      const instruct = options?.instruct?.trim() ?? '';
      const user = `${context.message?.userId?.toString() ?? '未知'}（${context.message?.sender?.nickname ?? '用户'}）`;

      const prompt = this.promptManager.render('llm.nsfw_reply', {
        char,
        instruct,
        user,
        userMessage: context.message.message,
        conversationHistory: historyText,
        groupMemoryText: memoryVars.groupMemoryText,
        userMemoryText: memoryVars.userMemoryText,
        retrievedConversationSection: memoryVars.retrievedConversationSection,
      });
      const baseSystemPrompt = this.promptManager.renderBasePrompt();

      // 300-500 word narrative replies; maxTokens capped for API limits (e.g. DeepSeek 4096)
      const response = await this.llmService.generate(
        prompt,
        {
          temperature: 0.8,
          maxTokens: 4096,
          sessionId,
          systemPrompt: baseSystemPrompt,
        },
        'deepseek', // now only deepseek supports NSFW mode
      );

      // NSFW mode: no card reply, output plain text only
      await this.hookManager.execute('onAIGenerationComplete', context);
      replaceReply(context, response.text, 'ai');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate NSFW reply:', err);
      throw err;
    }
  }

  /**
   * Generate reply from task results (unified entry for TaskSystem / ReplyTaskExecutor).
   * When message (or referenced message) has images, uses vision-capable provider; else default LLM.
   *
   * @param context - Hook context containing message and conversation history
   * @param taskResults - Task execution results (empty Map if no tasks)
   */
  async generateReplyFromTaskResults(context: HookContext, taskResults: Map<string, TaskResult>): Promise<void> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('Reply generation interrupted by hook');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      const taskResultImages = this.extractTaskResultImages(taskResults);
      const sessionId = context.metadata.get('sessionId');

      // 0. Resolve referenced (quoted) message once for text injection and image extraction.
      // Injection point: when resolved, userMessageOverride is built and passed to generateReplyWithTaskResults ->
      // buildReplyMessages -> final user block (current_query); when resolution fails, prompt keeps raw message only.
      let referencedMessage: NormalizedMessageEvent | null = null;
      let userMessageOverride: string | undefined;
      const replyMessageId = getReplyMessageIdFromMessage(context.message);
      if (replyMessageId !== null) {
        try {
          referencedMessage = await this.messageAPI.getMessageFromContext(
            replyMessageId,
            context.message,
            this.databaseManager,
          );
          const refText = (referencedMessage.message ?? '').trim();
          const hasImage = referencedMessage.segments?.some((s) => s.type === 'image');
          const referencedText = refText + (hasImage ? '（含图片）' : '');
          if (referencedText) {
            userMessageOverride = `被引用的消息：${referencedText}\n\n当前问题：${context.message.message ?? ''}`;
            logger.debug(
              `[ReplyGenerationService] Injected referenced message into prompt | messageSeq=${replyMessageId} | refLength=${referencedText.length}`,
            );
          }
        } catch (err) {
          referencedMessage = null;
          logger.debug(
            `[ReplyGenerationService] Referenced message not found, skipping text injection | messageSeq=${replyMessageId} | error=${err instanceof Error ? err.message : 'Unknown'}`,
          );
        }
      }

      // 1. Extract images from user message (and referenced reply message) for vision provider when present
      let messageImages: VisionImage[] = [];
      try {
        messageImages = await extractImagesFromMessageAndReply(
          context.message,
          this.messageAPI,
          this.databaseManager,
          referencedMessage,
        );
      } catch (err) {
        logger.warn('[ReplyGenerationService] Failed to extract message images, continuing without vision:', err);
      }

      // 2. Build task results summary
      const taskResultsSummary = this.buildTaskResultsSummary(taskResults);

      // 3. Optional recursive search (outsourced to RetrievalService: multi-round decision + filter-refine + optional page fetch).
      // Use stripped user message (no provider prefix): e.g. "claude 北京天气" -> "北京天气" so the search-decision LLM sees the actual question and can decide to search (instead of "claude ..." which may be interpreted as non-searchable).
      const { userMessage: messageForSearch } = this.providerRouter.routeReplyInput(context.message.message ?? '');

      let accumulatedSearchResults = '';
      if (this.retrievalService?.isSearchEnabled()) {
        this.fetchProgressNotifier.setMessageEvent(context.message);
        accumulatedSearchResults = await this.retrievalService.performRecursiveSearchRefined(
          messageForSearch,
          this.llmService,
          sessionId,
          this.MAX_SEARCH_ITERATIONS,
          this.fetchProgressNotifier,
        );
      }

      // 4. Generate final reply (vision provider when message has images, else default LLM)
      await this.generateReplyWithTaskResults(
        context,
        taskResultsSummary,
        accumulatedSearchResults,
        sessionId,
        messageImages,
        taskResultImages,
        userMessageOverride,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate reply from task results:', err);
      await this.hookManager.execute('onAIGenerationComplete', context);
      throw err;
    }
  }

  /**
   * Extract base64 images from task results (data.imageBase64)
   * Any task may contribute images; reply can include both text and images
   */
  private extractTaskResultImages(taskResults: Map<string, TaskResult>): string[] {
    const images: string[] = [];
    for (const result of taskResults.values()) {
      if (result.success && result.data?.imageBase64 && typeof result.data.imageBase64 === 'string') {
        images.push(result.data.imageBase64);
      }
    }
    return images;
  }

  /**
   * Append task result images to context.reply (text + images)
   */
  private appendTaskResultImages(context: HookContext, taskResultImages: string[]): void {
    if (taskResultImages.length === 0) return;
    const imageSegments = taskResultImages.map((base64) => ({
      type: 'image' as const,
      data: { uri: `base64://${base64}`, sub_type: 'normal' as const, summary: '' },
    }));
    setReplyWithSegments(context, imageSegments, 'ai', { isCardImage: true });
  }

  /**
   * Build task results summary for final reply generation
   */
  private buildTaskResultsSummary(taskResults: Map<string, TaskResult>): string {
    const summaries: string[] = [];

    for (const [taskType, result] of taskResults.entries()) {
      if (result.success) {
        summaries.push(`Task ${taskType}: ${result.reply}`);
      } else {
        summaries.push(`Task ${taskType}: Execution failed - ${result.error}`);
      }
    }

    return summaries.join('\n\n');
  }

  private getMessageIdString(context: HookContext): string {
    return String(context.message.id ?? context.message.messageId ?? `msg:${Date.now()}`);
  }

  /**
   * Build history for normal (episode) mode.
   * - SessionId is normalized so history and DB persistence use the same key (group:groupId / user:userId).
   * - New episode (no cache): initial context = last EPISODE_CONTEXT_WINDOW_SIZE (10) messages within 10 min before trigger; stable start for the episode.
   * - Existing episode (has cache): same start (cached prefix) + new messages from DB since last cached; when over cap, summarize front and set summary as new start (in memory).
   */
  private async buildNormalHistoryEntries(context: HookContext): Promise<{
    historyEntries: ConversationMessageEntry[];
    sessionId: string;
    episodeKey: string;
  }> {
    const rawSessionId = context.metadata.get('sessionId');
    const sessionType = (context.metadata.get('sessionType') as 'group' | 'user' | undefined) ?? 'group';
    const canonicalSessionId = normalizeSessionId(
      rawSessionId,
      sessionType,
      context.metadata.get('groupId'),
      context.metadata.get('userId'),
    );
    const now = new Date(context.message.timestamp ?? Date.now());
    const episode = this.episodeService.resolveEpisode({
      sessionId: canonicalSessionId,
      messageId: this.getMessageIdString(context),
      now,
      userMessage: context.message.message,
    });
    const episodeKey = this.episodeService.buildEpisodeKey(canonicalSessionId, episode);
    const currentMessageId = this.getMessageIdString(context);

    let entries: ConversationMessageEntry[];
    const cached = this.episodeHistoryCache.get(episodeKey);

    if (cached != null && cached.length > 0) {
      // Existing episode: stable start (cached) + new messages since last cached up to (excluding) current trigger.
      const lastCached = cached[cached.length - 1];
      const sinceAfterLast = new Date(lastCached.createdAt.getTime() + 1);
      const newMessages = await this.conversationHistoryService.getMessagesSinceForSession(
        canonicalSessionId,
        sessionType,
        sinceAfterLast,
        NORMAL_MAX_HISTORY_ENTRIES + 10,
      );
      const appended = newMessages.filter((e) => e.messageId !== currentMessageId);
      const combined = [...cached, ...appended];
      if (combined.length > NORMAL_MAX_HISTORY_ENTRIES) {
        // Summarize front (oldest) into one entry; that becomes the new stable start (in memory only).
        entries = await this.conversationHistoryService.replaceOldestWithSummary(
          combined,
          NORMAL_MAX_HISTORY_ENTRIES,
          new Date(),
        );
        this.episodeHistoryCache.set(episodeKey, entries);
      } else {
        entries = combined;
        this.episodeHistoryCache.set(episodeKey, entries);
      }
    } else {
      // New episode: last EPISODE_CONTEXT_WINDOW_SIZE (10) messages within 10 min before trigger; that defines the stable start.
      const raw = await this.conversationHistoryService.getMessagesSinceForSession(
        canonicalSessionId,
        sessionType,
        episode.contextWindowStart,
        500,
      );
      const startedAtTs = episode.startedAt.getTime();
      const inWindow = raw.filter((e) => e.createdAt.getTime() <= startedAtTs && e.messageId !== currentMessageId);
      entries = inWindow.slice(-NormalEpisodeService.EPISODE_CONTEXT_WINDOW_SIZE);
      // When 10-min window is empty, try last N from DB but still restrict to same 10-min window (never use old messages).
      if (entries.length === 0) {
        const contextWindowStartTs = episode.contextWindowStart.getTime();
        const recent = await this.conversationHistoryService.getRecentMessagesForSession(
          canonicalSessionId,
          sessionType,
          100,
        );
        const inWindowFromRecent = recent.filter(
          (e) =>
            e.messageId !== currentMessageId &&
            e.createdAt.getTime() >= contextWindowStartTs &&
            e.createdAt.getTime() <= startedAtTs,
        );
        entries = inWindowFromRecent.slice(-NormalEpisodeService.EPISODE_CONTEXT_WINDOW_SIZE);
      }
      this.episodeHistoryCache.set(episodeKey, entries);
    }

    return { historyEntries: entries, sessionId: canonicalSessionId, episodeKey };
  }

  /**
   * Maintain episode context window outside reply path outside reply path: when cache exceeds limit, replace oldest with summary and update cache.
   * Called fire-and-forget after reply completes so the next reply sees a stable summarized prefix.
   */
  private async maintainEpisodeContext(episodeKey: string | undefined): Promise<void> {
    if (!episodeKey) {
      return;
    }
    const cached = this.episodeHistoryCache.get(episodeKey);
    if (!cached || cached.length <= NORMAL_MAX_HISTORY_ENTRIES) {
      return;
    }
    try {
      const replaced = await this.conversationHistoryService.replaceOldestWithSummary(
        cached,
        NORMAL_MAX_HISTORY_ENTRIES,
        new Date(),
      );
      this.episodeHistoryCache.set(episodeKey, replaced);
    } catch (err) {
      logger.warn('[ReplyGenerationService] maintainEpisodeContext failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Used when building soft-context or image tags for history; kept for future use. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: reserved for soft-context or image-tag formatting
  private extractTextAndImageTags(segments: MessageSegment[] | undefined, fallbackText: string): string {
    if (!segments?.length) return fallbackText;
    const text = segments
      .filter((s): s is MessageSegment & { type: 'text' } => s.type === 'text')
      .map((s) => (s.type === 'text' ? String(s.data.text ?? '') : ''))
      .join('')
      .trim();
    const imageTags = segments
      .filter((s) => s.type === 'image')
      .map((s) => `<image uri="${String(s.data.uri ?? s.data.temp_url ?? s.data.resource_id ?? '')}" />`)
      .join('\n');
    if (text && imageTags) return `${text}\n${imageTags}`;
    return text || imageTags || fallbackText;
  }

  /** Used by VisionService fallback when provider has no generateWithVisionMessages; kept for consistency. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used indirectly via vision fallback path
  private flattenMessagesForVision(messages: ChatMessage[]): string {
    return messages
      .map((m) => {
        const contentStr =
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
        return `${m.role.toUpperCase()}:\n${contentStr}`;
      })
      .join('\n\n');
  }

  /** Build ContentPart[] for one history entry when provider has vision: text + image_url (data URL). */
  private buildContentPartsForEntry(entry: ConversationMessageEntry, normalizedImages: VisionImage[]): ContentPart[] {
    const textFromSegments = entry.segments
      ?.filter((s): s is MessageSegment & { type: 'text' } => s.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('')
      .trim();
    const textContent = textFromSegments || entry.content || '';
    const prefix = entry.isBotReply ? '' : `[speaker:${entry.userId}:${entry.nickname ?? ''}] `;
    const parts: ContentPart[] = [{ type: 'text', text: prefix + textContent || '(no text)' }];
    for (const img of normalizedImages) {
      const mime = img.mimeType || 'image/jpeg';
      const url = img.base64 ? `data:${mime};base64,${img.base64}` : img.url;
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    return parts;
  }

  private async buildReplyMessages(
    context: HookContext,
    taskResultsSummary: string,
    searchResultsText: string,
    userMessage: string,
    hasVision: boolean,
    messageImages: VisionImage[] = [],
  ): Promise<{ messages: ChatMessage[]; sessionId: string; episodeKey: string }> {
    const [retrievedConversationSection, memoryContextText, normalHistory] = await Promise.all([
      this.getRetrievedConversationSection(context),
      Promise.resolve(this.getMemoryContextText(context)),
      this.buildNormalHistoryEntries(context),
    ]);
    const taskResultText = this.getTaskResultsSummary(taskResultsSummary);
    const searchResultText = this.getSearchResultsSummary(searchResultsText);

    const baseSystemPrompt = this.promptManager.renderBasePrompt();
    const sceneSystemPrompt = this.promptManager.render('llm.reply.system', {});
    const frameCurrentQuery = this.promptManager.render('llm.reply.user_frame', {
      userMessage,
    });
    const finalUserBlocks = {
      memoryContext: memoryContextText,
      ragContext: retrievedConversationSection,
      searchResults: searchResultText,
      taskResults: taskResultText,
      currentQuery: frameCurrentQuery,
    };

    const messages = this.messageAssembler.buildNormalMessages({
      baseSystem: baseSystemPrompt,
      sceneSystem: sceneSystemPrompt,
      historyEntries: normalHistory.historyEntries,
      finalUserBlocks,
    });

    // When provider has vision, replace history entries that contain images with ContentPart[] (text + base64 image_url).
    if (hasVision && normalHistory.historyEntries.length > 0) {
      const getResourceUrl = (resourceId: string) => this.messageAPI.getResourceTempUrl(resourceId, context.message);
      const systemCount = 2; // baseSystem + sceneSystem
      for (let i = 0; i < normalHistory.historyEntries.length; i++) {
        const entry = normalHistory.historyEntries[i];
        const hasImage = entry.segments?.some((s) => s.type === 'image');
        if (!hasImage || !entry.segments?.length) {
          continue;
        }
        try {
          const visionImages = await extractImagesFromSegmentsAsync(entry.segments, getResourceUrl);
          if (visionImages.length === 0) {
            continue;
          }
          const normalized = await normalizeVisionImages(visionImages, {
            timeout: 15000,
            maxSize: 5 * 1024 * 1024,
          });
          const parts = this.buildContentPartsForEntry(entry, normalized);
          const msgIndex = systemCount + i;
          if (msgIndex < messages.length) {
            messages[msgIndex] = { ...messages[msgIndex], content: parts };
          }
        } catch (err) {
          logger.warn(
            `[ReplyGenerationService] Failed to resolve history images for entry ${entry.messageId}, keeping text placeholder:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // When vision and current message has images, normalize once and attach to last user message so VisionService uses as-is.
    if (hasVision && messageImages.length > 0) {
      const normalized = await normalizeVisionImages(messageImages, {
        timeout: 30000,
        maxSize: 10 * 1024 * 1024,
      });
      const imageParts: ContentPart[] = normalized
        .filter((img) => img.base64 || img.url)
        .map((img) => ({
          type: 'image_url' as const,
          image_url: {
            url: img.base64 ? `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` : (img.url ?? ''),
          },
        }));
      const last = messages[messages.length - 1];
      const lastContent: ContentPart[] =
        typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }, ...imageParts]
          : [...(last.content as ContentPart[]), ...imageParts];
      messages[messages.length - 1] = { ...last, content: lastContent };
    }

    this.messageHashCheck(messages);

    return { messages, sessionId: normalHistory.sessionId, episodeKey: normalHistory.episodeKey };
  }

  private messageHashCheck(messages: ChatMessage[]) {
    return new Promise(() => {
      const serialized = this.messageAssembler.serializeForFingerprint(messages);
      const fingerprint = NormalEpisodeService.hashMessages(serialized);
      logger.info(`[ReplyGenerationService] Prompt fingerprint=${fingerprint} | messageCount=${messages.length}`);
    });
  }

  /**
   * Build final reply messages and generate response.
   * Uses role-based messages. Vision fallback flattens messages into deterministic text prompt.
   *
   * @param context - Hook context
   * @param taskResultsSummary - Optional summary of task results (e.g. readFile). Injected as taskResults segment (may be empty).
   * @param searchResultsText - Refined search text from RetrievalService.performRecursiveSearchRefined (may be empty)
   * @param sessionId - Session ID
   * @param messageImages - Images from user message (and referenced message). When non-empty, reply is generated via vision provider.
   * @param taskResultImages - Base64 images from task results (data.imageBase64), appended to reply
   * @param userMessageOverride - When set (e.g. with referenced message text prepended), used as the user message for routing and prompt instead of context.message.message
   */
  private async generateReplyWithTaskResults(
    context: HookContext,
    taskResultsSummary: string,
    searchResultsText: string,
    sessionId: string,
    messageImages: VisionImage[] = [],
    taskResultImages: string[] = [],
    userMessageOverride?: string,
  ): Promise<void> {
    const rawInput = userMessageOverride ?? context.message.message ?? '';
    const { providerName, userMessage, reason, confidence, usedExplicitPrefix } =
      this.providerRouter.routeReplyInput(rawInput);
    const useVisionProvider = messageImages.length > 0;
    const built = await this.buildReplyMessages(
      context,
      taskResultsSummary,
      searchResultsText,
      userMessage,
      useVisionProvider,
      messageImages,
    );
    const messages = built.messages;
    const genOptions = { temperature: 0.7, maxTokens: 2000, sessionId };

    // Log reply flow and raw messages sent to provider (base64 in image_url replaced to avoid log explosion)
    logger.info(
      `[ReplyGenerationService] Provider routing | reason=${reason} | confidence=${confidence} | explicitPrefix=${usedExplicitPrefix} | provider=${providerName ?? 'default'}`,
    );
    const rawMessagesForLog = JSON.stringify(
      messages,
      (_, value) => {
        if (typeof value === 'string' && value.startsWith('data:') && value.includes('base64,')) {
          return '[base64 omitted]';
        }
        return value;
      },
      2,
    );
    logger.debug(
      `[ReplyGenerationService] Raw messages sent to provider (provider=${providerName ?? 'default'}):\n${rawMessagesForLog}`,
    );

    let response: AIGenerateResponse;
    if (useVisionProvider) {
      // Current message images already inlined in buildReplyMessages; pass empty so VisionService uses messages as-is.
      response = await this.visionService.generateWithVisionMessages(messages, [], genOptions);
    } else {
      response = await this.llmService.generateMessages(messages, genOptions, providerName);
    }

    logger.debug(`[ReplyGenerationService] LLM response received | responseLength=${response.text.length}`);

    if (this.shouldUseCardReply(response.text, sessionId, providerName)) {
      const success = await this.handleCardReply(response.text, sessionId, context, providerName);
      if (success) {
        this.appendTaskResultImages(context, taskResultImages);
        void this.maintainEpisodeContext(built.episodeKey).catch(() => {});
        return;
      }
    }

    // Hook: onAIGenerationComplete
    await this.hookManager.execute('onAIGenerationComplete', context);

    // Fallback to text when card path skipped or shouldUseCardRendering returned false
    replaceReply(context, response.text, 'ai');

    // Maintain episode context outside reply path (fire-and-forget): summarize when over limit so next reply sees stable prefix.
    void this.maintainEpisodeContext(built.episodeKey).catch(() => {});
  }

  private shouldUseCardReply(responseText: string, sessionId: string, providerName?: string): boolean {
    const cardThreshold = CardRenderingService.getThreshold();
    // Check if card rendering service is available (not local provider)
    const canUseCardFormat = this.cardRenderingService.shouldUseCardFormatPrompt(sessionId, providerName);
    return responseText.length >= cardThreshold && canUseCardFormat;
  }

  /**
   * Handle card reply rendering if applicable
   * Checks if response should be rendered as card and handles the conversion and rendering
   * @param responseText - Original text response
   * @param sessionId - Session ID for provider selection
   * @param context - Hook context for setting reply
   * @param providerName - Optional provider name (e.g. doubao, claude, deepseek) shown in card footer
   * @returns true if card was successfully rendered, false if should use text reply
   */
  private async handleCardReply(
    responseText: string,
    sessionId: string,
    context: HookContext,
    providerName?: string,
  ): Promise<boolean> {
    try {
      // Convert text to card format (use cheap provider only; never pass main reply provider)
      logger.info('[ReplyGenerationService] Converting response to card format');
      const cardFormatText = await this.convertToCardFormat(responseText, sessionId);

      // Check if conversion was successful (valid JSON card data)
      const shouldRender = this.cardRenderingService.shouldUseCardRendering(cardFormatText, sessionId, providerName);
      if (shouldRender) {
        logger.info('[ReplyGenerationService] Rendering card image for response');
        // Render card to image using CardRenderingService (provider required on all paths)
        const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
        const base64Image = await this.cardRenderingService.renderCard(cardFormatText, provider);

        // Store image data in context reply using segments
        // Use replace because card image is the final form of this AI reply
        const messageBuilder = new MessageBuilder();
        messageBuilder.image({ data: base64Image });
        replaceReplyWithSegments(
          context,
          messageBuilder.build(),
          'ai',
          { isCardImage: true, cardTextForHistory: cardFormatText }, // Store card text for history/cache; image only for sending
        );

        logger.info('[ReplyGenerationService] Card image rendered and stored in reply');
        // Hook: onAIGenerationComplete
        await this.hookManager.execute('onAIGenerationComplete', context);
        return true;
      } else {
        logger.debug('[ReplyGenerationService] Card conversion failed or invalid, falling back to text');
        return false;
      }
    } catch (cardError) {
      const cardErr = cardError instanceof Error ? cardError : new Error('Unknown card error');
      logger.warn('[ReplyGenerationService] Failed to convert to card format, falling back to text:', cardErr);
      return false;
    }
  }

  /**
   * Optionally convert reply text to card and render to image segments.
   * Used by flows that do not use HookContext (e.g. proactive reply). Caller sends segments and persists textForHistory.
   * @param replyText - Raw reply text from LLM
   * @param sessionId - Session ID for provider selection
   * @param providerName - Optional provider name (e.g. for proactive flow)
   * @returns { segments, textForHistory } when card was rendered; null when card skipped or failed (caller uses replyText as-is)
   */
  async processReplyMaybeCard(
    replyText: string,
    sessionId: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null> {
    if (!this.shouldUseCardReply(replyText, sessionId, providerName)) {
      return null;
    }
    try {
      logger.info('[ReplyGenerationService] Converting proactive response to card format');
      const cardFormatText = await this.convertToCardFormat(replyText, sessionId);
      const shouldRender = this.cardRenderingService.shouldUseCardRendering(cardFormatText, sessionId, providerName);
      if (!shouldRender) {
        logger.debug('[ReplyGenerationService] Card conversion failed or invalid for proactive reply');
        return null;
      }
      logger.info('[ReplyGenerationService] Rendering card image for proactive reply');
      const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
      const base64Image = await this.cardRenderingService.renderCard(cardFormatText, provider);
      const messageBuilder = new MessageBuilder();
      messageBuilder.image({ data: base64Image });
      return {
        segments: messageBuilder.build(),
        textForHistory: cardFormatText,
      };
    } catch (cardError) {
      const cardErr = cardError instanceof Error ? cardError : new Error('Unknown card error');
      logger.warn('[ReplyGenerationService] Proactive card render failed, falling back to text:', cardErr);
      return null;
    }
  }

  /**
   * Convert text response to card format JSON.
   * Always uses a cheap provider (doubao), never the main reply provider (e.g. anthropic).
   */
  private async convertToCardFormat(responseText: string, sessionId?: string): Promise<string> {
    const prompt = this.promptManager.render('llm.reply.convert_to_card', {
      responseText,
    });

    logger.debug('[ReplyGenerationService] Converting text to card format using LLM');

    const cardResponse = await this.llmService.generate(
      prompt,
      {
        temperature: 0.3,
        maxTokens: 2000,
        sessionId,
      },
      CONVERT_TO_CARD_PROVIDER,
    );

    logger.debug(
      `[ReplyGenerationService] Card format conversion completed | responseLength=${cardResponse.text.length}`,
    );

    return cardResponse.text;
  }
}

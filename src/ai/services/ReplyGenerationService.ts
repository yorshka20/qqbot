// Reply Generation Service - provides AI reply generation capabilities

import type { MessageAPI } from '@/api/methods/MessageAPI';
import {
  computeSendAsForward,
  hasWhitelistCapability,
  replaceReply,
  replaceReplyWithSegments,
  setReplyWithSegments,
} from '@/context/HookContextHelpers';
import {
  type ConversationHistoryService,
  type ConversationMessageEntry,
  NormalEpisodeService,
  normalizeSessionId,
} from '@/conversation/history';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import { WHITELIST_CAPABILITY } from '@/plugins/plugins/whitelistCapabilities';
import { CardRenderingService, getCardDeckNoteForPrompt, getCardTypeSpecForPrompt } from '@/services/card';
import type { RetrievalService } from '@/services/retrieval';
import { QdrantClient } from '@/services/retrieval';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import type { VisionImage } from '../capabilities/types';
import type { PromptManager } from '../prompt/PromptManager';
import { PromptMessageAssembler } from '../prompt/PromptMessageAssembler';
import type { ProviderRouter } from '../routing/ProviderRouter';
import { buildSkillUsageInstructions, executeSkillCall, getReplySkillDefinitions } from '../tools/replyTools';
import type { AIGenerateResponse, ChatMessage, ContentPart, ToolDefinition } from '../types';
import { containsTextToolCalls, stripTextToolCalls } from '../utils/dsmlParser';
import { formatRAGConversationContext } from '../utils/formatRAGConversationContext';
import {
  extractImagesFromMessageAndReply,
  extractImagesFromSegmentsAsync,
  getReplyMessageIdFromMessage,
  normalizeVisionImages,
} from '../utils/imageUtils';
import { extractExpectedJsonFromLlmText } from '../utils/llmJsonExtract';
import type { LLMService } from './LLMService';
import type { VisionService } from './VisionService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Grouped parameters for the LLM generation pipeline.
 * Replaces the 9+ positional params previously threaded through
 * attemptLLMGeneration → generateWithRetry → generateReplyWithToolResults.
 */
interface ReplyGenerationPipelineParams {
  messages: ChatMessage[];
  genOptions: {
    temperature: number;
    maxTokens: number;
    sessionId: string;
    reasoningEffort: 'medium';
    episodeKey?: string;
  };
  useVisionProvider: boolean;
  canUseVisionToolUse: boolean;
  toolDefinitions: ToolDefinition[];
  resolvedVisionProviderName: string | null;
  selectedProviderName: string | undefined;
  effectiveNativeSearchEnabled: boolean;
}

/** Result of the LLM generation pipeline (attempt / retry). */
interface ReplyGenerationPipelineResult {
  response: AIGenerateResponse;
  actualProvider: string | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Reply Generation Service
 * Provides AI reply generation capabilities including basic replies, vision support, and task-based replies.
 *
 * Reply paths:
 * - generateReplyFromToolResults: main entry (ReplySystem / ReplyToolExecutor); when message has images uses vision provider, else default LLM.
 * - generateNsfwReply: no search (fixed NSFW prompt only).
 */
/** Normal mode: max history entries in prompt (stable size for cache hit). Excludes current user message; when exceeded, oldest are summarized. Initial context window (10 min) is defined in NormalEpisodeService.CONTEXT_WINDOW_MS. */
const NORMAL_MAX_HISTORY_ENTRIES = 24;

export class ReplyGenerationService {
  private static readonly RAG_LIMIT = 5;
  private static readonly RAG_MIN_SCORE = 0.5;

  private config: Config;

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
    private toolManager: ToolManager,
  ) {
    this.config = getContainer().resolve<Config>(DITokens.CONFIG);
  }

  /**
   * Build RAG-retrieved conversation section for prompt injection. Returns empty string when RAG disabled or no hits.
   * Uses the user's full message for a single vector search (no query extraction). Limit 5 results, each with time and participants.
   */
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
   * Uses RAG semantic search when available, falls back to keyword-based filtering.
   */
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

    // Get memory filter config
    const memoryConfig = this.config.getMemoryConfig();
    const filterConfig = memoryConfig.filter;

    // If filtering is disabled, use full memory (legacy behavior)
    if (filterConfig?.enabled === false) {
      return this.memoryService.getMemoryTextForReply(groupId, userId);
    }

    // Use async RAG-based filtering (with keyword fallback)
    const result = await this.memoryService.getFilteredMemoryForReplyAsync(groupId, userId, {
      userMessage,
      maxLength: filterConfig?.maxLength ?? 2000,
      alwaysIncludeScopes: filterConfig?.alwaysIncludeScopes ?? ['instruction', 'rule'],
      minRelevanceScore: filterConfig?.minRelevanceScore ?? 0.5, // Higher threshold for RAG
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

    // Only include sections that have content
    const hasGroupMemory = groupMemoryText.trim().length > 0;
    const hasUserMemory = userMemoryText.trim().length > 0;

    if (!hasGroupMemory && !hasUserMemory) {
      return '';
    }

    // Build memory context with only non-empty sections
    const sections: string[] = [];
    if (hasGroupMemory) {
      sections.push(`## 关于本群的记忆\n${groupMemoryText}`);
    }
    if (hasUserMemory) {
      sections.push(`## 关于当前用户的记忆\n${userMemoryText}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Get memory vars for reply (group + user memory text + RAG retrieved conversation section). Used when building reply prompts.
   */
  private async getMemoryVarsForReply(
    context: HookContext,
  ): Promise<{ groupMemoryText: string; userMemoryText: string; retrievedConversationSection: string }> {
    const [memoryVars, retrievedConversationSection] = await Promise.all([
      this.getMemoryVarsAsync(context),
      this.getRetrievedConversationSection(context),
    ]);
    return { ...memoryVars, retrievedConversationSection };
  }

  /**
   * Render task + search segment for reply prompt (like rag.conversation_context). Returns empty string when both are empty.
   */
  private getToolResultsSummary(taskResults: string): string {
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
    // Gate: do not run LLM when access denied or group lacks reply capability.
    if (context.metadata.get('whitelistDenied')) {
      return;
    }
    if (!hasWhitelistCapability(context, WHITELIST_CAPABILITY.reply)) {
      return;
    }

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
      const textSegments = [{ type: 'text' as const, data: { text: response.text } }];
      replaceReply(context, response.text, 'ai', {
        sendAsForward: computeSendAsForward(context, textSegments),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate NSFW reply:', err);
      throw err;
    }
  }

  /**
   * Generate reply from task results (unified entry for ReplySystem / ReplyToolExecutor).
   * When message (or referenced message) has images, uses vision-capable provider; else default LLM.
   *
   * @param context - Hook context containing message and conversation history
   * @param taskResults - Skill/task execution results (empty Map if no pre-executed tasks)
   */
  async generateReplyFromToolResults(context: HookContext, taskResults: Map<string, ToolResult>): Promise<void> {
    // Gate: do not run any LLM when access denied or group lacks reply capability (must check before any work).
    if (context.metadata.get('whitelistDenied')) {
      return;
    }
    if (!hasWhitelistCapability(context, WHITELIST_CAPABILITY.reply)) {
      return;
    }

    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('Reply generation interrupted by hook');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      const taskResultImages = this.extractToolResultImages(taskResults);
      const sessionId = context.metadata.get('sessionId');

      // 0. Resolve referenced (quoted) message once for text injection and image extraction.
      // Injection point: when resolved, userMessageOverride is built and passed to generateReplyWithToolResults ->
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
      const taskResultsSummary = this.buildToolResultsSummary(taskResults);

      // 3. Generate final reply (vision provider when message has images, else default LLM).
      // Search/fetch/RAG/memory decisions are handled inside the same skill loop.
      await this.generateReplyWithToolResults(
        context,
        taskResultsSummary,
        '',
        sessionId,
        messageImages,
        taskResultImages,
        userMessageOverride,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate reply from task results:', err);
      await this.hookManager.execute('onAIGenerationComplete', context);

      // Send error message to user so they know the bot failed
      const errorMessage = `抱歉，AI 回复生成失败：${err.message || '未知错误'}。请稍后再试。`;
      const textSegments = [{ type: 'text' as const, data: { text: errorMessage } }];
      replaceReply(context, errorMessage, 'ai', {
        sendAsForward: computeSendAsForward(context, textSegments),
      });
    }
  }

  /**
   * Extract base64 images from task results (data.imageBase64)
   * Any task may contribute images; reply can include both text and images
   */
  private extractToolResultImages(taskResults: Map<string, ToolResult>): string[] {
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
  private appendToolResultImages(context: HookContext, taskResultImages: string[]): void {
    if (taskResultImages.length === 0) return;
    const imageSegments = taskResultImages.map((base64) => ({
      type: 'image' as const,
      data: { uri: `base64://${base64}`, sub_type: 'normal' as const, summary: '' },
    }));
    setReplyWithSegments(context, imageSegments, 'ai', {
      isCardImage: true,
      sendAsForward: computeSendAsForward(context, imageSegments),
    });
  }

  /**
   * Build task results summary for final reply generation
   */
  private buildToolResultsSummary(taskResults: Map<string, ToolResult>): string {
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
    const sessionType = context.metadata.get('sessionType');
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
    toolUsageInstructions: string,
    hasVision: boolean,
    messageImages: VisionImage[] = [],
  ): Promise<{ messages: ChatMessage[]; sessionId: string; episodeKey: string }> {
    const [retrievedConversationSection, memoryContextText, normalHistory] = await Promise.all([
      this.getRetrievedConversationSection(context),
      this.getMemoryContextTextAsync(context),
      this.buildNormalHistoryEntries(context),
    ]);
    const taskResultText = this.getToolResultsSummary(taskResultsSummary);
    const searchResultText = this.getSearchResultsSummary(searchResultsText);
    // When whitelist is not full permissions, inject fragment into base system via variable.
    const groupCaps = context.metadata.get('whitelistGroupCapabilities');
    const whitelistFragment =
      Array.isArray(groupCaps) && groupCaps.length > 0
        ? (this.promptManager.render('llm.whitelist_limited.system') ?? '').trim()
        : '';
    const baseSystemPrompt = this.promptManager.renderBasePrompt({
      whitelistLimitedFragment: whitelistFragment,
    });
    const contextInstruct = this.promptManager.render('llm.context.instruct');
    const toolInstruct = this.promptManager.render('llm.tool.instruct', { toolUsageInstructions });

    const sceneSystemPrompt = this.promptManager.render('llm.reply.system', {
      contextInstruct,
      toolInstruct,
    });
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

  // ---------------------------------------------------------------------------
  // LLM generation pipeline (attempt + retry)
  // ---------------------------------------------------------------------------

  /**
   * Execute a single LLM generation attempt with the given provider.
   * Sets context.metadata 'usedCardFormat' when the LLM called format_as_card.
   */
  private async attemptLLMGeneration(
    context: HookContext,
    params: ReplyGenerationPipelineParams,
  ): Promise<ReplyGenerationPipelineResult> {
    const {
      messages,
      genOptions,
      useVisionProvider,
      canUseVisionToolUse,
      toolDefinitions,
      resolvedVisionProviderName,
      selectedProviderName,
      effectiveNativeSearchEnabled,
    } = params;

    // Reset per-attempt so retries with fallback providers start clean.
    context.metadata.delete('usedCardFormat');

    const toolExecutor = (call: { name: string; arguments: string }) =>
      executeSkillCall(call, context, this.toolManager, this.hookManager);

    const toolUseOptions = {
      temperature: genOptions.temperature,
      maxTokens: genOptions.maxTokens,
      maxToolRounds: 4,
      sessionId: genOptions.sessionId,
      nativeWebSearch: effectiveNativeSearchEnabled,
      toolExecutor,
    };

    const requestedProvider = selectedProviderName ?? resolvedVisionProviderName ?? undefined;

    if (useVisionProvider) {
      if (canUseVisionToolUse && toolDefinitions.length > 0) {
        const r = await this.llmService.generateWithTools(
          messages,
          toolDefinitions,
          toolUseOptions,
          resolvedVisionProviderName ?? undefined,
        );
        return {
          response: { text: r.text, resolvedProviderName: r.resolvedProviderName },
          actualProvider: r.resolvedProviderName ?? requestedProvider,
        };
      }
      const r = await this.visionService.generateWithVisionMessages(
        messages,
        [],
        genOptions,
        resolvedVisionProviderName ?? undefined,
      );
      return { response: r, actualProvider: r.resolvedProviderName ?? requestedProvider };
    }

    if (toolDefinitions.length > 0) {
      const r = await this.llmService.generateWithTools(
        messages,
        toolDefinitions,
        toolUseOptions,
        selectedProviderName,
      );
      return {
        response: { text: r.text, resolvedProviderName: r.resolvedProviderName },
        actualProvider: r.resolvedProviderName ?? requestedProvider,
      };
    }

    const r = await this.llmService.generateMessages(
      messages,
      { ...genOptions, nativeWebSearch: effectiveNativeSearchEnabled },
      selectedProviderName,
    );
    return { response: r, actualProvider: r.resolvedProviderName ?? requestedProvider };
  }

  /**
   * Generate with retry and provider fallback.
   * Tries the primary provider first; on failure triggers a health check and retries with
   * alternative providers in cost order (doubao → deepseek → gemini → openai → anthropic).
   */
  private async generateWithRetry(
    context: HookContext,
    params: ReplyGenerationPipelineParams,
  ): Promise<ReplyGenerationPipelineResult> {
    const MAX_RETRIES = 4;

    try {
      return await this.attemptLLMGeneration(context, params);
    } catch (primaryError) {
      const primaryProviderLabel = params.selectedProviderName ?? params.resolvedVisionProviderName ?? 'default';
      logger.error(
        `[ReplyGenerationService] Primary provider "${primaryProviderLabel}" failed, triggering health check and attempting fallback`,
        primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
      );

      void this.llmService
        .triggerHealthCheck()
        .catch((e) =>
          logger.warn('[ReplyGenerationService] Background health check failed:', e instanceof Error ? e.message : e),
        );

      const alternatives = this.llmService.getAlternativeProviderNames(primaryProviderLabel);
      let lastError: Error = primaryError instanceof Error ? primaryError : new Error(String(primaryError));

      for (let retry = 0; retry < Math.min(MAX_RETRIES, alternatives.length); retry++) {
        const fallbackProvider = alternatives[retry];
        logger.info(
          `[ReplyGenerationService] Retry ${retry + 1}/${MAX_RETRIES} with fallback provider "${fallbackProvider}"`,
        );
        try {
          const fallbackParams: ReplyGenerationPipelineParams = {
            ...params,
            useVisionProvider: false,
            canUseVisionToolUse: false,
            resolvedVisionProviderName: null,
            selectedProviderName: fallbackProvider,
          };
          const result = await this.attemptLLMGeneration(context, fallbackParams);
          logger.info(`[ReplyGenerationService] Fallback provider "${fallbackProvider}" succeeded`);
          return result;
        } catch (retryError) {
          lastError = retryError instanceof Error ? retryError : new Error(String(retryError));
          logger.error(`[ReplyGenerationService] Fallback provider "${fallbackProvider}" also failed`, lastError);
        }
      }

      throw lastError;
    }
  }

  // ---------------------------------------------------------------------------
  // Main reply generation: prepare → generate → dispatch
  // ---------------------------------------------------------------------------

  /**
   * Build final reply messages and generate response.
   * Pipeline: routing → capabilities → tools → prompt build → LLM generate → dispatch response.
   */
  private async generateReplyWithToolResults(
    context: HookContext,
    taskResultsSummary: string,
    searchResultsText: string,
    sessionId: string,
    messageImages: VisionImage[] = [],
    taskResultImages: string[] = [],
    userMessageOverride?: string,
  ): Promise<void> {
    // --- Prepare: routing, capabilities, tools, prompt ---
    const pipelineParams = await this.prepareGenerationPipeline(
      context,
      taskResultsSummary,
      searchResultsText,
      sessionId,
      messageImages,
      userMessageOverride,
    );

    // --- Generate ---
    const result = await this.generateWithRetry(context, pipelineParams);

    logger.debug(
      `[ReplyGenerationService] LLM response received | responseLength=${result.response.text.length} | actualProvider=${result.actualProvider ?? 'default'} | usedCardFormat=${context.metadata.get('usedCardFormat') ?? false}`,
    );

    // --- Dispatch: route response to card / text path ---
    await this.dispatchReplyResponse(context, result, sessionId, taskResultImages);

    // Maintain episode context (fire-and-forget)
    void this.maintainEpisodeContext(pipelineParams.episodeKey).catch(() => {});
  }

  /**
   * Prepare all parameters for the LLM generation pipeline:
   * routing, vision, capabilities, tools, prompt messages.
   */
  private async prepareGenerationPipeline(
    context: HookContext,
    taskResultsSummary: string,
    searchResultsText: string,
    sessionId: string,
    messageImages: VisionImage[],
    userMessageOverride?: string,
  ): Promise<ReplyGenerationPipelineParams & { episodeKey: string }> {
    // Routing
    const rawInput = userMessageOverride ?? context.message.message ?? '';
    const { providerName, userMessage, reason, confidence, usedExplicitPrefix } =
      this.providerRouter.routeReplyInput(rawInput);

    // Vision and provider
    const useVisionProvider = messageImages.length > 0;
    const resolvedVisionProviderName = useVisionProvider
      ? await this.visionService.getAvailableProviderName(providerName, sessionId)
      : null;
    const selectedProviderName = useVisionProvider ? (resolvedVisionProviderName ?? providerName) : providerName;

    // Capabilities: check if the effective provider supports tool use
    const effectiveProvider = selectedProviderName ?? 'default';
    const providerCanUseTools = await this.checkProviderToolUseSupport(effectiveProvider, sessionId);
    const canUseVisionToolUse = useVisionProvider ? Boolean(resolvedVisionProviderName && providerCanUseTools) : false;
    const effectiveNativeSearchEnabled = false;

    // Tools: only inject when the provider actually supports tool use
    const toolDefinitions =
      !providerCanUseTools || (useVisionProvider && !canUseVisionToolUse)
        ? []
        : getReplySkillDefinitions(this.toolManager, { nativeWebSearchEnabled: effectiveNativeSearchEnabled });

    // Prompt messages
    const toolUsageInstructions = buildSkillUsageInstructions(
      this.toolManager,
      toolDefinitions,
      { nativeWebSearchEnabled: effectiveNativeSearchEnabled },
      this.promptManager,
    );
    const built = await this.buildReplyMessages(
      context,
      taskResultsSummary,
      searchResultsText,
      userMessage,
      toolUsageInstructions,
      useVisionProvider,
      messageImages,
    );

    const maxTokens = toolDefinitions.length > 0 ? 4000 : 2000;
    const genOptions = {
      temperature: 0.7,
      maxTokens,
      sessionId,
      reasoningEffort: 'medium' as const,
      episodeKey: built.episodeKey,
    };

    // Log
    logger.info(
      `[ReplyGenerationService] Provider routing | reason=${reason} | confidence=${confidence} | explicitPrefix=${usedExplicitPrefix} | provider=${providerName ?? 'default'}`,
    );
    logger.debug(
      `[ReplyGenerationService] Raw messages sent to provider (provider=${providerName ?? 'default'}):\n${JSON.stringify(
        built.messages,
        (_, v) => (typeof v === 'string' && v.startsWith('data:') && v.includes('base64,') ? '[base64 omitted]' : v),
        2,
      )}`,
    );

    return {
      messages: built.messages,
      genOptions,
      useVisionProvider,
      canUseVisionToolUse,
      toolDefinitions,
      resolvedVisionProviderName,
      selectedProviderName,
      effectiveNativeSearchEnabled,
      episodeKey: built.episodeKey,
    };
  }

  // ---------------------------------------------------------------------------
  // Response dispatch: card (direct / conversion) or text
  // ---------------------------------------------------------------------------

  /**
   * Route LLM response to the appropriate output path:
   * 1. Direct card (LLM produced card JSON via format_as_card) → render directly
   * 2. Conversion card (long text) → convert via second LLM call → render
   * 3. Plain text fallback
   */
  private async dispatchReplyResponse(
    context: HookContext,
    result: ReplyGenerationPipelineResult,
    sessionId: string,
    taskResultImages: string[],
  ): Promise<void> {
    const { response, actualProvider } = result;
    const usedCardFormat = context.metadata.get('usedCardFormat') === true;

    // Path 1: LLM already produced card JSON via format_as_card tool
    if (usedCardFormat) {
      const success = await this.tryRenderCardReply(context, response.text, actualProvider);
      if (success) {
        this.appendToolResultImages(context, taskResultImages);
        return;
      }
      logger.warn('[ReplyGenerationService] Direct card JSON from LLM failed to render, attempting JSON extraction');
      // Try extracting clean JSON from the response (LLM may have mixed extra text with card JSON)
      const cleanJson = extractExpectedJsonFromLlmText(response.text);
      if (cleanJson) {
        const retrySuccess = await this.tryRenderCardReply(context, cleanJson, actualProvider);
        if (retrySuccess) {
          this.appendToolResultImages(context, taskResultImages);
          return;
        }
      }
      // Card rendering truly failed (e.g. Puppeteer unavailable) — extract readable text as last resort
      logger.warn('[ReplyGenerationService] Card rendering failed completely, extracting readable text');
      const readableText = this.extractReadableTextFromCardJson(response.text);
      await this.hookManager.execute('onAIGenerationComplete', context);
      const textSegments = [{ type: 'text' as const, data: { text: readableText } }];
      replaceReply(context, readableText, 'ai', {
        sendAsForward: computeSendAsForward(context, textSegments),
      });
      return;
    }

    // Path 2: Long text → convert to card via second LLM call
    if (this.shouldUseCardReply(response.text)) {
      // If text is already card JSON (LLM produced it without calling format_as_card tool), render directly
      if (this.looksLikeCardJson(response.text)) {
        logger.info(
          '[ReplyGenerationService] Text already looks like card JSON, rendering directly (skipping conversion)',
        );
        const cleanJson = extractExpectedJsonFromLlmText(response.text) ?? response.text;
        const success = await this.tryRenderCardReply(context, cleanJson, actualProvider);
        if (success) {
          this.appendToolResultImages(context, taskResultImages);
          return;
        }
      }
      const cardResult = await this.convertAndRenderCard(response.text, sessionId, actualProvider);
      if (cardResult) {
        this.setCardReplyOnContext(context, cardResult.segments, cardResult.textForHistory);
        await this.hookManager.execute('onAIGenerationComplete', context);
        this.appendToolResultImages(context, taskResultImages);
        return;
      }
    }

    // Path 3: Plain text
    await this.hookManager.execute('onAIGenerationComplete', context);
    let finalText = response.text;
    // Safety net: strip any text-based tool call blocks that leaked through
    if (containsTextToolCalls(finalText)) {
      logger.warn('[ReplyGenerationService] Stripping leaked text-based tool call blocks from final reply');
      finalText = stripTextToolCalls(finalText);
    }
    // Safety net: if text looks like card JSON (shouldn't reach here, but guard against it)
    if (this.looksLikeCardJson(finalText)) {
      logger.warn('[ReplyGenerationService] Plain text path received card JSON, extracting readable text');
      finalText = this.extractReadableTextFromCardJson(finalText);
    }
    const textSegments = [{ type: 'text' as const, data: { text: finalText } }];
    replaceReply(context, finalText, 'ai', {
      sendAsForward: computeSendAsForward(context, textSegments),
    });
  }

  // ---------------------------------------------------------------------------
  // Card rendering (shared by all card paths)
  // ---------------------------------------------------------------------------

  /** Render card JSON string → image segments. Pure rendering, no context/hook side effects. */
  private async renderCardJsonToSegments(
    cardJson: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string }> {
    const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
    const base64Image = await this.cardRenderingService.renderCard(cardJson, provider);
    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: base64Image });
    return { segments: messageBuilder.build(), textForHistory: cardJson };
  }

  /** Set card image reply on context with standard options. */
  private setCardReplyOnContext(context: HookContext, segments: MessageSegment[], cardTextForHistory: string): void {
    replaceReplyWithSegments(context, segments, 'ai', {
      isCardImage: true,
      cardTextForHistory,
      sendAsForward: computeSendAsForward(context, segments),
    });
  }

  /**
   * Try to render card JSON and set reply on context. Returns true on success.
   * Used for direct card path (LLM already produced JSON) and as shared rendering helper.
   */
  private async tryRenderCardReply(context: HookContext, cardJson: string, providerName?: string): Promise<boolean> {
    try {
      const result = await this.renderCardJsonToSegments(cardJson, providerName);
      this.setCardReplyOnContext(context, result.segments, result.textForHistory);
      logger.info('[ReplyGenerationService] Card image rendered and stored in reply');
      await this.hookManager.execute('onAIGenerationComplete', context);
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ReplyGenerationService] Card rendering failed:', err.message);
      return false;
    }
  }

  /** Convert text → card JSON via second LLM call, then render to segments. Returns null on failure. */
  private async convertAndRenderCard(
    responseText: string,
    sessionId: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null> {
    try {
      logger.info('[ReplyGenerationService] Converting response to card format via LLM');
      const cardJson = await this.convertToCardFormat(responseText, sessionId);
      logger.debug(`[ReplyGenerationService] Card format text: ${cardJson}`);
      return await this.renderCardJsonToSegments(cardJson, providerName);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown card error');
      logger.warn('[ReplyGenerationService] Card conversion/rendering failed, falling back to text:', err);
      return null;
    }
  }

  private shouldUseCardReply(responseText: string): boolean {
    return responseText.length >= CardRenderingService.getThreshold();
  }

  /** Heuristic: does the text look like card JSON (array of card objects with "type" field)? */
  private looksLikeCardJson(text: string): boolean {
    const jsonStr = extractExpectedJsonFromLlmText(text);
    if (!jsonStr) return false;
    try {
      const parsed = JSON.parse(jsonStr);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        typeof parsed[0] === 'object' &&
        parsed[0] !== null &&
        'type' in parsed[0]
      );
    } catch {
      return false;
    }
  }

  /** Extract human-readable text from card JSON by pulling out text/content fields per card type. */
  private extractReadableTextFromCardJson(text: string): string {
    try {
      const jsonStr = extractExpectedJsonFromLlmText(text);
      if (!jsonStr) return text;
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return text;

      const parts: string[] = [];
      for (const card of parsed) {
        if (typeof card !== 'object' || card === null) continue;
        // Extract readable text based on known card type fields
        if (card.title) parts.push(`## ${card.title}`);
        if (card.question) parts.push(`**${card.question}**`);
        if (card.answer) parts.push(card.answer);
        if (card.content) parts.push(card.content);
        if (card.summary) parts.push(card.summary);
        if (card.detail) parts.push(card.detail);
        if (card.text) parts.push(card.text);
        if (Array.isArray(card.items)) parts.push(card.items.map((item: unknown) => `• ${item}`).join('\n'));
        if (Array.isArray(card.steps))
          parts.push(card.steps.map((s: unknown, i: number) => `${i + 1}. ${s}`).join('\n'));
        if (Array.isArray(card.left) && Array.isArray(card.right)) {
          if (card.leftHeader) parts.push(`**${card.leftHeader}**: ${card.left.join(', ')}`);
          if (card.rightHeader) parts.push(`**${card.rightHeader}**: ${card.right.join(', ')}`);
        }
      }
      const result = parts.join('\n\n').trim();
      return result || text;
    } catch {
      return text;
    }
  }

  /**
   * Handle card reply (public API for external callers like AIService/proactive flow).
   * With context: set reply on context, run hook, return boolean.
   * Without context: return { segments, textForHistory } or null.
   */
  async handleCardReply(
    responseText: string,
    sessionId: string,
    options: { context: HookContext; providerName?: string },
  ): Promise<boolean>;
  async handleCardReply(
    responseText: string,
    sessionId: string,
    options?: { providerName?: string },
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null>;
  async handleCardReply(
    responseText: string,
    sessionId: string,
    options?: { context?: HookContext; providerName?: string },
  ): Promise<boolean | { segments: MessageSegment[]; textForHistory: string } | null> {
    if (!this.shouldUseCardReply(responseText)) {
      return options?.context != null ? false : null;
    }
    // If text is already card JSON (e.g. proactive LLM output card JSON without format_as_card tool), render directly
    if (this.looksLikeCardJson(responseText)) {
      logger.info(
        '[ReplyGenerationService] Text already looks like card JSON, rendering directly (skipping conversion)',
      );
      const cleanJson = extractExpectedJsonFromLlmText(responseText) ?? responseText;
      const directResult = await this.renderCardJsonToSegments(cleanJson, options?.providerName).catch(() => null);
      if (directResult) {
        if (options?.context != null) {
          this.setCardReplyOnContext(options.context, directResult.segments, directResult.textForHistory);
          logger.info('[ReplyGenerationService] Card image rendered and stored in reply');
          await this.hookManager.execute('onAIGenerationComplete', options.context);
          return true;
        }
        return directResult;
      }
      // Direct render failed, fall through to conversion
    }
    const cardResult = await this.convertAndRenderCard(responseText, sessionId, options?.providerName);
    if (!cardResult) {
      return options?.context != null ? false : null;
    }
    if (options?.context != null) {
      this.setCardReplyOnContext(options.context, cardResult.segments, cardResult.textForHistory);
      logger.info('[ReplyGenerationService] Card image rendered and stored in reply');
      await this.hookManager.execute('onAIGenerationComplete', options.context);
      return true;
    }
    return cardResult;
  }

  /**
   * Convert text response to card format JSON.
   * Always uses a cheap provider (doubao), never the main reply provider (e.g. anthropic).
   */
  private async convertToCardFormat(responseText: string, sessionId?: string): Promise<string> {
    const prompt = this.promptManager.render('llm.reply.convert_to_card', {
      responseText,
      cardTypeSpec: getCardTypeSpecForPrompt(),
      cardDeckNote: getCardDeckNoteForPrompt(),
    });

    const aiConfig = this.config.getAIConfig();
    const convertLlmProvider = aiConfig?.taskProviders?.convert ?? aiConfig?.defaultProviders?.llm ?? 'deepseek';
    const convertLlmModel = aiConfig?.taskProviders?.convertModel ?? '';

    const cardResponse = await this.llmService.generateLite(
      prompt,
      {
        temperature: 0.2,
        maxTokens: 4000,
        sessionId,
        model: convertLlmModel,
        jsonMode: true,
      },
      convertLlmProvider,
    );

    logger.debug(
      `[ReplyGenerationService] Card format conversion completed | responseLength=${cardResponse.text.length}`,
    );

    return cardResponse.text;
  }

  private async supportsNativeWebSearch(providerName?: string, sessionId?: string): Promise<boolean> {
    const candidate = this.llmService as LLMService & {
      supportsNativeWebSearch?: (providerName?: string, sessionId?: string) => Promise<boolean>;
    };
    if (typeof candidate.supportsNativeWebSearch !== 'function') {
      return false;
    }
    return candidate.supportsNativeWebSearch(providerName, sessionId);
  }

  /**
   * Check if the resolved provider supports tool use.
   * Resolves the actual provider name (handling 'default') and checks against configured toolUseProviders.
   */
  private async checkProviderToolUseSupport(providerNameOrDefault: string, sessionId?: string): Promise<boolean> {
    // Resolve the actual provider name (the provider that will handle this request)
    const provider = await this.llmService.getAvailableProvider(
      providerNameOrDefault === 'default' ? undefined : providerNameOrDefault,
      sessionId,
    );
    if (!provider) return false;
    const resolvedName = 'name' in provider ? (provider as { name: string }).name : providerNameOrDefault;
    return this.llmService.providerSupportsToolUse(resolvedName);
  }
}

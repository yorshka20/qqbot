// Reply Generation Service - provides AI reply generation capabilities

import type { MessageAPI } from '@/api/methods/MessageAPI';
import { replaceReply, replaceReplyWithSegments, setReplyWithSegments } from '@/context/HookContextHelpers';
import type { ConversationHistoryService } from '@/conversation/history';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { RetrievalService } from '@/retrieval';
import { QdrantClient } from '@/retrieval';
import type { TaskResult } from '@/task/types';
import { logger } from '@/utils/logger';
import { type FetchProgressNotifier, MessageSendFetchProgressNotifier } from '@/utils/MessageSendFetchProgressNotifier';
import type { VisionImage } from '../capabilities/types';
import type { PromptManager } from '../prompt/PromptManager';
import type { AIGenerateResponse } from '../types';
import { formatRAGConversationContext } from '../utils/formatRAGConversationContext';
import { extractImagesFromMessageAndReply } from '../utils/imageUtils';
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
export class ReplyGenerationService {
  private readonly MAX_SEARCH_ITERATIONS = 5;

  private static readonly RAG_LIMIT = 5;
  private static readonly RAG_MIN_SCORE = 0.5;

  /** Single FetchProgressNotifier instance for reply flow; setMessageEvent() before each search. */
  readonly fetchProgressNotifier: FetchProgressNotifier;

  constructor(
    private llmService: LLMService,
    private visionService: VisionService,
    private cardRenderingService: CardRenderingService,
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

      // 300-500 word narrative replies; maxTokens capped for API limits (e.g. DeepSeek 4096)
      const response = await this.llmService.generate(
        prompt,
        {
          temperature: 0.8,
          maxTokens: 4096,
          sessionId,
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

      // 1. Extract images from user message (and referenced reply message) for vision provider when present
      let messageImages: VisionImage[] = [];
      try {
        messageImages = await extractImagesFromMessageAndReply(context.message, this.messageAPI, this.databaseManager);
      } catch (err) {
        logger.warn('[ReplyGenerationService] Failed to extract message images, continuing without vision:', err);
      }

      // 2. Build task results summary
      const taskResultsSummary = this.buildTaskResultsSummary(taskResults);

      // 3. Optional recursive search (outsourced to RetrievalService: multi-round decision + filter-refine + optional page fetch)
      let accumulatedSearchResults = '';
      if (this.retrievalService?.isSearchEnabled()) {
        this.fetchProgressNotifier.setMessageEvent(context.message);
        accumulatedSearchResults = await this.retrievalService.performRecursiveSearchRefined(
          context.message.message,
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

  /**
   * Make prompt inject records for reply prompt.
   * @param context - Hook context
   * @param taskResultsSummary - Summary of task results
   * @param searchResultsText - Summary of search results
   * @returns Prompt inject records
   */
  private async buildReplyPromptInjectRecords(
    context: HookContext,
    taskResultsSummary: string,
    searchResultsText: string,
  ): Promise<Record<string, string>> {
    const [retrievedConversationSection, conversationHistory] = await Promise.all([
      this.getRetrievedConversationSection(context),
      this.conversationHistoryService.buildConversationHistory(context),
    ]);
    const memoryContextText = this.getMemoryContextText(context);
    const taskResultText = this.getTaskResultsSummary(taskResultsSummary);
    const searchResultText = this.getSearchResultsSummary(searchResultsText);

    return {
      userMessage: context.message.message,
      conversationHistory,
      memoryContextText,
      retrievedConversationSection,
      taskResultText,
      searchResultText,
    };
  }

  /**
   * Build final reply prompt and generate response (shared by generateReplyFromTaskResults, generateReplyWithVision).
   * Uses llm.reply only; task and search results are assembled via renderReplyExtraContext (llm.reply_extra_context fragment) into extraContextSection.
   * When messageImages.length > 0 uses vision-capable provider (generateWithVision); otherwise uses default LLM (generate).
   *
   * @param context - Hook context
   * @param taskResultsSummary - Optional summary of task results (e.g. readFile). Injected as taskResults segment (may be empty).
   * @param searchResultsText - Refined search text from RetrievalService.performRecursiveSearchRefined (may be empty)
   * @param sessionId - Session ID
   * @param messageImages - Images from user message (and referenced message). When non-empty, reply is generated via vision provider.
   * @param taskResultImages - Base64 images from task results (data.imageBase64), appended to reply
   */
  private async generateReplyWithTaskResults(
    context: HookContext,
    taskResultsSummary: string,
    searchResultsText: string,
    sessionId: string,
    messageImages: VisionImage[] = [],
    taskResultImages: string[] = [],
  ): Promise<void> {
    const injectRecords = await this.buildReplyPromptInjectRecords(context, taskResultsSummary, searchResultsText);
    const prompt = this.promptManager.render('llm.reply', injectRecords, { injectBase: true });

    const genOptions = { temperature: 0.7, maxTokens: 2000, sessionId };
    const useVisionProvider = messageImages.length > 0;

    logger.debug(`[ReplyGenerationService] generateReplyWithTaskResults`, { prompt });

    let response: AIGenerateResponse;
    if (useVisionProvider) {
      response = await this.visionService.generateWithVision(prompt, messageImages, genOptions);
    } else {
      response = await this.llmService.generate(prompt, genOptions);
    }

    logger.debug(`[ReplyGenerationService] LLM response received | responseLength=${response.text.length}`);

    // Try to handle as card reply if applicable
    if (this.shouldUseCardReply(response.text, sessionId)) {
      const success = await this.handleCardReply(response.text, sessionId, context);
      if (success) {
        this.appendTaskResultImages(context, taskResultImages);
        return;
      }
    }

    // Hook: onAIGenerationComplete
    await this.hookManager.execute('onAIGenerationComplete', context);

    // If card reply failed or skipped, use text reply - use replace (same AI reply update)
    // Set text reply to context
    replaceReply(context, response.text, 'ai');
  }

  private shouldUseCardReply(responseText: string, sessionId: string): boolean {
    const cardThreshold = CardRenderingService.getThreshold();
    // Check if card rendering service is available (not local provider)
    const canUseCardFormat = this.cardRenderingService.shouldUseCardFormatPrompt(sessionId);
    return responseText.length >= cardThreshold && canUseCardFormat;
  }

  /**
   * Handle card reply rendering if applicable
   * Checks if response should be rendered as card and handles the conversion and rendering
   * @param responseText - Original text response
   * @param sessionId - Session ID for provider selection
   * @param context - Hook context for setting reply
   * @returns true if card was successfully rendered, false if should use text reply
   */
  private async handleCardReply(responseText: string, sessionId: string, context: HookContext): Promise<boolean> {
    try {
      // Convert text to card format
      logger.info('[ReplyGenerationService] Converting response to card format');
      const cardFormatText = await this.convertToCardFormat(responseText, sessionId);

      // Check if conversion was successful (valid JSON card data)
      const shouldRender = this.cardRenderingService.shouldUseCardRendering(cardFormatText, sessionId);
      if (shouldRender) {
        logger.info('[ReplyGenerationService] Rendering card image for response');
        // Render card to image using CardRenderingService
        const base64Image = await this.cardRenderingService.renderCard(cardFormatText);

        // Store image data in context reply using segments
        // Use replace because card image is the final form of this AI reply
        const messageBuilder = new MessageBuilder();
        messageBuilder.image({ data: base64Image });
        replaceReplyWithSegments(
          context,
          messageBuilder.build(),
          'ai',
          { isCardImage: true }, // Set flag in metadata
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
   * Convert text response to card format JSON
   * This method is called when response length exceeds threshold
   * @param responseText - Original text response
   * @param sessionId - Session ID for provider selection
   * @returns Card format JSON string
   */
  private async convertToCardFormat(responseText: string, sessionId?: string): Promise<string> {
    // Use dedicated conversion prompt template
    const prompt = this.promptManager.render(
      'llm.reply.convert_to_card',
      {
        responseText,
      },
      { injectBase: true },
    );

    logger.debug('[ReplyGenerationService] Converting text to card format using LLM');

    // Generate card format response
    const cardResponse = await this.llmService.generate(prompt, {
      temperature: 0.3, // Lower temperature for more consistent JSON output
      maxTokens: 2000,
      sessionId,
    });

    logger.debug(
      `[ReplyGenerationService] Card format conversion completed | responseLength=${cardResponse.text.length}`,
    );

    return cardResponse.text;
  }
}

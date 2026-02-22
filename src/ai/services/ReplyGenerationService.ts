// Reply Generation Service - provides AI reply generation capabilities

import type { MessageAPI } from '@/api/methods/MessageAPI';
import { replaceReply, replaceReplyWithSegments, setReply } from '@/context/HookContextHelpers';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { SearchService } from '@/search';
import type { TaskResult } from '@/task/types';
import { logger } from '@/utils/logger';
import type { VisionImage } from '../capabilities/types';
import { PromptManager } from '../prompt/PromptManager';
import { extractImagesFromMessageAndReply, extractImagesFromSegments } from '../utils/imageUtils';
import { parseSearchDecision as parseSearchDecisionShared } from '../utils/searchDecisionParser';
import { CardRenderingService } from './CardRenderingService';
import { ConversationHistoryService } from './ConversationHistoryService';
import { LLMService } from './LLMService';
import { VisionService } from './VisionService';

/**
 * Reply Generation Service
 * Provides AI reply generation capabilities including basic replies, vision support, and task-based replies
 */
export class ReplyGenerationService {
  private readonly MAX_SEARCH_ITERATIONS = 5;

  constructor(
    private llmService: LLMService,
    private visionService: VisionService,
    private cardRenderingService: CardRenderingService,
    private promptManager: PromptManager,
    private hookManager: HookManager,
    private conversationHistoryService: ConversationHistoryService,
    private searchService?: SearchService,
    private messageAPI?: MessageAPI,
    private databaseManager?: DatabaseManager,
    private memoryService?: MemoryService,
  ) {}

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

  /**
   * Generate AI reply for user message
   * This method can be called by other systems (e.g., TaskSystem) to generate AI replies
   * Implements two-step process: 1) Check if search is needed, 2) Generate reply with or without search results
   * Supports card rendering for non-local providers when response is long
   * Reply is set to context.reply via setReply or setReplyWithSegments
   *
   * @param context - Hook context containing message and conversation history
   * @param providedSearchResults - Optional search results text. If provided, will be used instead of automatic search.
   *                                This allows callers (e.g., ReplyTaskExecutor) to provide search results from search tasks.
   */
  async generateReply(context: HookContext, providedSearchResults?: string): Promise<void> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      // Build conversation history for prompt (from in-memory or DB when empty after restart)
      const historyText = await this.conversationHistoryService.buildConversationHistory(context);

      // Get session ID for provider selection and context loading
      const sessionId = context.metadata.get('sessionId');

      // Use provided search results if available, otherwise perform automatic search
      let searchResultsText = '';
      if (providedSearchResults) {
        logger.debug('[ReplyGenerationService] Using provided search results from caller');
        searchResultsText = providedSearchResults;
      } else if (this.searchService) {
        // Perform smart search if search service is available and no results were provided
        searchResultsText =
          (await this.searchService.performSmartSearch(context.message.message, this.llmService, sessionId)) ?? '';
      }

      const memoryVars = this.getMemoryVars(context);
      let prompt: string;
      if (searchResultsText) {
        prompt = this.promptManager.render(
          'llm.reply.with_search',
          {
            userMessage: context.message.message,
            conversationHistory: historyText,
            searchResults: searchResultsText,
            groupMemoryText: memoryVars.groupMemoryText,
            userMemoryText: memoryVars.userMemoryText,
            imageDescription: '',
          },
          { injectBase: true },
        );
      } else {
        prompt = this.promptManager.render(
          'llm.reply',
          {
            userMessage: context.message.message,
            conversationHistory: historyText,
            groupMemoryText: memoryVars.groupMemoryText,
            userMemoryText: memoryVars.userMemoryText,
            imageDescription: '',
          },
          { injectBase: true },
        );
      }

      // Generate AI response using LLM service
      const response = await this.llmService.generate(prompt, {
        temperature: 0.6,
        maxTokens: 2000,
        sessionId,
      });

      logger.debug(`[ReplyGenerationService] LLM response received | responseLength=${response.text.length}`);

      // Try to handle as card reply if applicable
      const success = await this.handleCardReply(response.text, sessionId, context);
      if (success) {
        // Card reply has been built into context
        return;
      }

      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);

      // Set text reply to context
      // Use replace because this is fallback from card reply attempt (same AI reply update)
      replaceReply(context, response.text, 'ai');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate AI reply:', err);
      throw err;
    }
  }

  /**
   * Generate reply using NSFW-mode prompt template only (fixed reply flow, no task analysis or search).
   * Used when session is in NSFW mode; reply is set to context.reply.
   * Template uses {{char}} (bot's roleplay character) and {{user}} (user's role/name) for narrative RP.
   */
  async generateNsfwReply(context: HookContext): Promise<void> {
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      const historyText = await this.conversationHistoryService.buildConversationHistory(context);
      const sessionId = context.metadata.get('sessionId');
      const memoryVars = this.getMemoryVars(context);

      // char = bot's roleplay character name; user = user's role/name (for template "演绎{{char}}以及{{user}}之外...")
      const char = '助手';
      const user = context.message?.sender?.nickname ?? '用户';

      const prompt = this.promptManager.render('llm.nsfw_reply', {
        char,
        user,
        userMessage: context.message.message,
        conversationHistory: historyText,
        groupMemoryText: memoryVars.groupMemoryText,
        userMemoryText: memoryVars.userMemoryText,
        imageDescription: '',
      }, { injectBase: true });

      // Higher maxTokens to allow 300-500 word narrative replies per template
      const response = await this.llmService.generate(prompt, {
        temperature: 0.8,
        maxTokens: 3500,
        sessionId,
      }, 'ollama');

      logger.debug(`[ReplyGenerationService] NSFW reply received | responseLength=${response.text.length}`);

      const success = await this.handleCardReply(response.text, sessionId, context);
      if (success) {
        return;
      }

      await this.hookManager.execute('onAIGenerationComplete', context);
      replaceReply(context, response.text, 'ai');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate NSFW reply:', err);
      throw err;
    }
  }

  /**
   * Generate reply with vision support (multimodal)
   * When images are present: explain images via vision, then feed description into normal LLM flow (same templates, card reply).
   * Reply is set to context.reply via setReply
   */
  async generateReplyWithVision(context: HookContext, images?: VisionImage[]): Promise<void> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      const sessionId = context.metadata.get('sessionId');
      const historyText = await this.conversationHistoryService.buildConversationHistory(context);
      const memoryVars = this.getMemoryVars(context);

      let imageDescription = '';
      if (images && images.length > 0) {
        // Explain images first, then use normal LLM flow with image description
        const explainPrompt = this.promptManager.render('vision.explain_image', {
          userDescription: context.message.message || '（无）',
        });
        const explainResponse = await this.visionService.explainImages(images, explainPrompt, {
          temperature: 0.3,
          maxTokens: 2000,
          sessionId,
        });
        imageDescription = explainResponse.text;
        logger.debug(`[ReplyGenerationService] Image description: ${imageDescription}`);
      }

      // Build prompt with imageDescription (empty when no images)
      const prompt = this.promptManager.render(
        'llm.reply',
        {
          userMessage: context.message.message,
          conversationHistory: historyText,
          groupMemoryText: memoryVars.groupMemoryText,
          userMemoryText: memoryVars.userMemoryText,
          imageDescription,
        },
        { injectBase: true },
      );

      const response = await this.llmService.generate(prompt, {
        temperature: 0.5,
        maxTokens: 2000,
        sessionId,
      });

      logger.debug(`[ReplyGenerationService] LLM response received | responseLength=${response.text.length}`);

      // Try to handle as card reply if applicable
      if (sessionId) {
        const success = await this.handleCardReply(response.text, sessionId, context);
        if (success) {
          return;
        }
      }

      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);

      // Set text reply to context
      setReply(context, response.text, 'ai');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate AI reply with vision:', err);
      throw err;
    }
  }

  /**
   * Generate reply from task results
   * This is the unified entry point for generating bot replies after task execution.
   * Handles all cases: with/without images, with/without task results, with/without search.
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
      const sessionId = context.metadata.get('sessionId');

      // 1. Extract images from current message and/or referenced reply message
      let images: VisionImage[] = [];
      if (this.messageAPI && this.databaseManager) {
        try {
          images = await extractImagesFromMessageAndReply(context.message, this.messageAPI, this.databaseManager);
        } catch (error) {
          logger.warn(
            '[ReplyGenerationService] Failed to extract images from message and reply, falling back to text-only reply:',
            error instanceof Error ? error.message : error,
          );
        }
      } else {
        const messageSegments = context.message.segments;
        const hasImagesInSegments = messageSegments?.some((seg) => seg.type === 'image');
        if (hasImagesInSegments && messageSegments) {
          images = extractImagesFromSegments(messageSegments as any[]);
        }
      }
      const hasImages = images.length > 0;

      // 2. Extract search task results from taskResults
      const searchTaskResult = taskResults.get('search');
      let accumulatedSearchResults = searchTaskResult?.success ? searchTaskResult.reply : '';

      // 3. Build task results summary (exclude search, as it's handled separately)
      const otherTaskResults = new Map(taskResults);
      otherTaskResults.delete('search');
      const taskResultsSummary = this.buildTaskResultsSummary(otherTaskResults);

      // 4. Perform recursive search (max 5 iterations). Run for image messages too (user content is text + image description).
      if (this.searchService) {
        accumulatedSearchResults = await this.performRecursiveSearch(
          context.message.message,
          taskResultsSummary,
          accumulatedSearchResults,
          sessionId,
          this.MAX_SEARCH_ITERATIONS,
        );
      }

      // 5. Generate reply. When hasImages: explain images first, then same path as no-images with imageDescription.
      let imageDescription = '';
      if (hasImages && images) {
        const explainPrompt = this.promptManager.render('vision.explain_image', {
          userDescription: context.message.message || '（无）',
        });
        const explainResponse = await this.visionService.explainImages(images, explainPrompt, {
          temperature: 0.5,
          maxTokens: 2000,
          sessionId,
        });
        imageDescription = explainResponse.text;
        logger.debug(`[ReplyGenerationService] Image description: ${imageDescription}`);
      }
      await this.generateReplyWithTaskResults(
        context,
        taskResultsSummary,
        accumulatedSearchResults,
        sessionId,
        imageDescription || undefined,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyGenerationService] Failed to generate reply from task results:', err);
      await this.hookManager.execute('onAIGenerationComplete', context);
      throw err;
    }
  }

  /**
   * Build task results summary for final reply generation
   */
  buildTaskResultsSummary(taskResults: Map<string, TaskResult>): string {
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
   * Perform recursive search with AI decision making
   * AI analyzes search results and decides if more search is needed
   * Maximum 5 iterations
   *
   * @param userMessage - Original user message
   * @param taskResultsSummary - Summary of task execution results
   * @param existingSearchResults - Previously accumulated search results
   * @param sessionId - Session ID for provider selection
   * @param maxIterations - Maximum number of search iterations (default: 5)
   * @returns Accumulated search results
   */
  private async performRecursiveSearch(
    userMessage: string,
    taskResultsSummary: string,
    existingSearchResults: string,
    sessionId?: string,
    maxIterations: number = this.MAX_SEARCH_ITERATIONS,
  ): Promise<string> {
    if (!this.searchService) {
      return existingSearchResults;
    }

    let accumulatedResults = existingSearchResults;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      logger.debug(`[ReplyGenerationService] Recursive search iteration ${iteration}/${maxIterations}`);

      // 1. Let AI analyze if more search is needed
      const searchDecision = await this.makeSearchDecision(
        userMessage,
        taskResultsSummary,
        accumulatedResults,
        sessionId,
      );

      // 2. If no search needed, exit loop
      if (!searchDecision.needsSearch) {
        logger.debug(`[ReplyGenerationService] AI decided no more search needed at iteration ${iteration}`);
        break;
      }

      // 3. Execute search
      let searchResults: string[] = [];
      if (searchDecision.isMultiSearch && searchDecision.queries) {
        // Multiple search queries
        logger.info(
          `[ReplyGenerationService] Performing multi-search (iteration ${iteration}):`,
          searchDecision.queries.map((q) => q.query),
        );

        const searchPromises = searchDecision.queries.map(async (queryInfo) => {
          try {
            const results = await this.searchService!.search(queryInfo.query);
            return this.searchService!.formatSearchResults(results);
          } catch (error) {
            logger.warn(`[ReplyGenerationService] Search failed for query "${queryInfo.query}":`, error);
            return '';
          }
        });

        searchResults = await Promise.all(searchPromises);
      } else if (searchDecision.query) {
        // Single search query
        logger.info(`[ReplyGenerationService] Performing search (iteration ${iteration}): ${searchDecision.query}`);

        try {
          const results = await this.searchService.search(searchDecision.query);
          const formatted = this.searchService.formatSearchResults(results);
          searchResults = [formatted];
        } catch (error) {
          logger.warn(`[ReplyGenerationService] Search failed for query "${searchDecision.query}":`, error);
          searchResults = [''];
        }
      }

      // 4. Merge search results
      const newResults = searchResults.filter((r) => r).join('\n\n');
      if (newResults) {
        if (accumulatedResults) {
          accumulatedResults = `${accumulatedResults}\n\n--- Search Results Round ${iteration} ---\n\n${newResults}`;
        } else {
          accumulatedResults = newResults;
        }
        logger.debug(`[ReplyGenerationService] Search results accumulated, total length: ${accumulatedResults.length}`);
      } else {
        logger.warn(`[ReplyGenerationService] No search results obtained at iteration ${iteration}, stopping`);
        break;
      }
    }

    if (iteration >= maxIterations) {
      logger.info(`[ReplyGenerationService] Reached maximum search iterations (${maxIterations})`);
    }

    return accumulatedResults;
  }

  /**
   * Make search decision using AI
   * AI analyzes current information and decides if search is needed
   *
   * @param userMessage - Original user message
   * @param taskResultsSummary - Summary of task execution results
   * @param existingSearchResults - Previously accumulated search results
   * @param sessionId - Session ID for provider selection
   * @returns Search decision with query/queries or no search needed
   */
  private async makeSearchDecision(
    userMessage: string,
    taskResultsSummary: string,
    existingSearchResults: string,
    sessionId?: string,
  ): Promise<{
    needsSearch: boolean;
    query?: string;
    queries?: Array<{ query: string; explanation: string }>;
    isMultiSearch?: boolean;
  }> {
    if (!this.searchService) {
      return { needsSearch: false };
    }

    // Build decision prompt
    const decisionPrompt = this.promptManager.render(
      'llm.search_decision',
      {
        userMessage,
        existingInformation: existingSearchResults || 'None',
        taskResults: taskResultsSummary || 'None',
        previousSearchResults: existingSearchResults || 'None',
      },
      { injectBase: true },
    );

    // Call LLM to make decision
    const decisionResponse = await this.llmService.generate(decisionPrompt, {
      temperature: 0.3, // Lower temperature for more consistent decision
      maxTokens: 200, // Enough for decision and query
      sessionId,
    });

    // Parse decision result using shared parser
    return parseSearchDecisionShared(decisionResponse.text);
  }

  /**
   * Generate text reply with task results
   * @param context - Hook context
   * @param taskResultsSummary - Summary of task results
   * @param searchResultsText - Search results text
   * @param sessionId - Session ID
   * @param imageDescription - Optional image description from explainImages (when message had images)
   */
  private async generateReplyWithTaskResults(
    context: HookContext,
    taskResultsSummary: string,
    searchResultsText: string,
    sessionId?: string,
    imageDescription?: string,
  ): Promise<void> {
    const historyText = await this.conversationHistoryService.buildConversationHistory(context);

    // Build prompt (include imageDescription in all templates)
    const memoryVars = this.getMemoryVars(context);
    const imageDescVar = imageDescription ?? '';
    let prompt: string;
    if (taskResultsSummary) {
      // Has task results, use merge_tasks template
      prompt = this.promptManager.render(
        'llm.reply.merge_tasks',
        {
          userMessage: context.message.message,
          conversationHistory: historyText,
          taskResults: taskResultsSummary,
          searchResults: searchResultsText,
          groupMemoryText: memoryVars.groupMemoryText,
          userMemoryText: memoryVars.userMemoryText,
          imageDescription: imageDescVar,
        },
        { injectBase: true },
      );
    } else if (searchResultsText) {
      // Only search results, use with_search template
      prompt = this.promptManager.render(
        'llm.reply.with_search',
        {
          userMessage: context.message.message,
          conversationHistory: historyText,
          searchResults: searchResultsText,
          groupMemoryText: memoryVars.groupMemoryText,
          userMemoryText: memoryVars.userMemoryText,
          imageDescription: imageDescVar,
        },
        { injectBase: true },
      );
    } else {
      // No task results and search, use normal template
      prompt = this.promptManager.render(
        'llm.reply',
        {
          userMessage: context.message.message,
          conversationHistory: historyText,
          groupMemoryText: memoryVars.groupMemoryText,
          userMemoryText: memoryVars.userMemoryText,
          imageDescription: imageDescVar,
        },
        { injectBase: true },
      );
    }

    const response = await this.llmService.generate(prompt, {
      temperature: 0.7,
      maxTokens: 2000,
      sessionId,
    });

    logger.debug(`[ReplyGenerationService] LLM response received | responseLength=${response.text.length}`);

    // Try to handle as card reply if applicable
    if (sessionId) {
      const success = await this.handleCardReply(response.text, sessionId, context);
      if (success) {
        return;
      }
      // If card reply failed, fallback to text - use replace (same AI reply update)
      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);
      replaceReply(context, response.text, 'ai');
      return;
    }

    // Hook: onAIGenerationComplete
    await this.hookManager.execute('onAIGenerationComplete', context);

    // Set text reply to context
    // Use append because this is a new AI reply (no card attempt)
    setReply(context, response.text, 'ai');
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
    // Check if response length exceeds threshold
    const cardThreshold = CardRenderingService.getThreshold();
    const shouldConvertToCard = responseText.length >= cardThreshold;

    if (!shouldConvertToCard) {
      return false;
    }

    // Check if card rendering service is available (not local provider)
    const canUseCardFormat = this.cardRenderingService.shouldUseCardFormatPrompt(sessionId);

    if (!canUseCardFormat) {
      return false;
    }

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

// Generation stage — LLM call with retry/fallback + tool execution loop.

import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { LLMService } from '../../services/LLMService';
import type { VisionService } from '../../services/VisionService';
import { executeSkillCall } from '../../tools/replyTools';
import type { AIGenerateResponse, ChatMessage, ToolDefinition } from '../../types';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/** Grouped parameters for the LLM generation pipeline. */
interface GenerationPipelineParams {
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
interface GenerationPipelineResult {
  response: AIGenerateResponse;
  actualProvider: string | undefined;
}

/**
 * Pipeline stage 7: LLM generation.
 * Dispatches the assembled messages to the appropriate LLM path (vision+tools,
 * vision-only, tools-only, or plain text) and implements retry with provider
 * fallback (doubao → deepseek → gemini → openai → anthropic) on failure.
 */
export class GenerationStage implements ReplyStage {
  readonly name = 'generation';

  constructor(
    private llmService: LLMService,
    private visionService: VisionService,
    private toolManager: ToolManager,
    private hookManager: HookManager,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    if (!ctx.genOptions) {
      throw new Error('[GenerationStage] genOptions not set — PromptAssemblyStage must run first');
    }

    const params: GenerationPipelineParams = {
      messages: ctx.messages,
      genOptions: ctx.genOptions,
      useVisionProvider: ctx.useVisionProvider,
      canUseVisionToolUse: ctx.canUseVisionToolUse,
      toolDefinitions: ctx.toolDefinitions,
      resolvedVisionProviderName: ctx.resolvedVisionProviderName,
      selectedProviderName: ctx.selectedProviderName,
      effectiveNativeSearchEnabled: ctx.effectiveNativeSearchEnabled,
    };

    const result = await this.generateWithRetry(ctx.hookContext, params);

    ctx.responseText = result.response.text;
    ctx.actualProvider = result.actualProvider;

    logger.debug(
      `[GenerationStage] LLM response received | responseLength=${result.response.text.length} | actualProvider=${result.actualProvider ?? 'default'} | usedCardFormat=${ctx.hookContext.metadata.get('usedCardFormat') ?? false}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Single attempt
  // ---------------------------------------------------------------------------

  private async attemptLLMGeneration(
    context: HookContext,
    params: GenerationPipelineParams,
  ): Promise<GenerationPipelineResult> {
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

  // ---------------------------------------------------------------------------
  // Retry with fallback
  // ---------------------------------------------------------------------------

  private async generateWithRetry(
    context: HookContext,
    params: GenerationPipelineParams,
  ): Promise<GenerationPipelineResult> {
    const MAX_RETRIES = 4;

    try {
      return await this.attemptLLMGeneration(context, params);
    } catch (primaryError) {
      const primaryProviderLabel = params.selectedProviderName ?? params.resolvedVisionProviderName ?? 'default';
      logger.error(
        `[GenerationStage] Primary provider "${primaryProviderLabel}" failed, triggering health check and attempting fallback`,
        primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
      );

      void this.llmService
        .triggerHealthCheck()
        .catch((e) =>
          logger.warn('[GenerationStage] Background health check failed:', e instanceof Error ? e.message : e),
        );

      const alternatives = this.llmService.getAlternativeProviderNames(primaryProviderLabel);
      let lastError: Error = primaryError instanceof Error ? primaryError : new Error(String(primaryError));

      for (let retry = 0; retry < Math.min(MAX_RETRIES, alternatives.length); retry++) {
        const fallbackProvider = alternatives[retry];
        logger.info(`[GenerationStage] Retry ${retry + 1}/${MAX_RETRIES} with fallback provider "${fallbackProvider}"`);
        try {
          const fallbackParams: GenerationPipelineParams = {
            ...params,
            useVisionProvider: false,
            canUseVisionToolUse: false,
            resolvedVisionProviderName: null,
            selectedProviderName: fallbackProvider,
          };
          const result = await this.attemptLLMGeneration(context, fallbackParams);
          logger.info(`[GenerationStage] Fallback provider "${fallbackProvider}" succeeded`);
          return result;
        } catch (retryError) {
          lastError = retryError instanceof Error ? retryError : new Error(String(retryError));
          logger.error(`[GenerationStage] Fallback provider "${fallbackProvider}" also failed`, lastError);
        }
      }

      throw lastError;
    }
  }
}

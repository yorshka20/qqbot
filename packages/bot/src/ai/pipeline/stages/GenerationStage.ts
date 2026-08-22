// Generation stage — LLM call with retry/fallback + tool execution loop.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationConfigService } from '@/conversation/ConversationConfigService';
import type { ReasoningEffort } from '@/core/config/types/ai';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { LLMService } from '../../services/LLMService';
import { executeSkillCall } from '../../tools/replyTools';
import type { AIGenerateResponse, ChatMessage, ToolDefinition } from '../../types';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/** Forward nodes reject very large payloads; thinking traces can run long on tool turns. */
const MAX_THINKING_CHARS = 4000;

/** Grouped parameters for the LLM generation pipeline. */
interface GenerationPipelineParams {
  messages: ChatMessage[];
  genOptions: {
    temperature: number;
    maxTokens?: number;
    sessionId: string;
    reasoningEffort: ReasoningEffort;
    episodeKey?: string;
  };
  toolDefinitions: ToolDefinition[];
  selectedProviderName: string | undefined;
  effectiveNativeSearchEnabled: boolean;
  /** Set only when `/think` is on for this session; each tool round's thinking is sent as it lands. */
  onReasoning?: (text: string) => Promise<void>;
}

/** Result of the LLM generation pipeline (attempt / retry). */
interface GenerationPipelineResult {
  response: AIGenerateResponse;
  actualProvider: string | undefined;
}

/**
 * Pipeline stage 7: LLM generation.
 * Dispatches the assembled messages to the LLM (with or without tools) and
 * implements retry with provider fallback on failure. Images are already
 * embedded as ContentPart[] in messages — each provider converts them to its
 * native format in its own generate path.
 */
export class GenerationStage implements ReplyStage {
  readonly name = 'generation';

  constructor(
    private llmService: LLMService,
    private toolManager: ToolManager,
    private hookManager: HookManager,
    private messageAPI: MessageAPI,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    if (!ctx.genOptions) {
      throw new Error('[GenerationStage] genOptions not set — PromptAssemblyStage must run first');
    }

    const onReasoning = await this.createThinkingSender(ctx);

    const params: GenerationPipelineParams = {
      messages: ctx.messages,
      genOptions: ctx.genOptions,
      toolDefinitions: ctx.toolDefinitions,
      selectedProviderName: ctx.selectedProviderName,
      effectiveNativeSearchEnabled: ctx.effectiveNativeSearchEnabled,
      onReasoning,
    };

    const result = await this.generateWithRetry(ctx.hookContext, params);

    ctx.responseText = result.response.text;
    ctx.actualProvider = result.actualProvider;

    logger.debug(
      `[GenerationStage] LLM response received | responseLength=${result.response.text.length} | actualProvider=${result.actualProvider ?? 'default'} | cardSent=${ctx.hookContext.metadata.get('cardSent') ?? false}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Thinking output (/think)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the `/think` setting once per turn and return a per-round sender, or
   * undefined when thinking output is off — the caller then omits the callback
   * entirely rather than paying a config lookup on every tool round.
   *
   * ConversationConfigService is resolved lazily because it is registered after
   * AIService builds the stage list.
   */
  private async createThinkingSender(
    ctx: ReplyPipelineContext,
  ): Promise<((text: string) => Promise<void>) | undefined> {
    if (!ctx.sessionId) {
      return undefined;
    }
    try {
      const configService = getContainer().resolve<ConversationConfigService>(DITokens.CONVERSATION_CONFIG_SERVICE);
      const sessionType = ctx.hookContext.message.messageType === 'group' ? 'group' : 'user';
      if (!(await configService.getShowThinking(ctx.sessionId, sessionType))) {
        return undefined;
      }
    } catch (err) {
      logger.warn('[GenerationStage] Failed to read /think setting; thinking output disabled:', err);
      return undefined;
    }

    let round = 0;
    return async (text: string) => {
      round++;
      // Read the provider per round: a mid-turn fallback changes who is answering.
      const provider =
        (ctx.hookContext.metadata.get('activeProvider') as string | undefined) ?? ctx.selectedProviderName;
      await this.sendThinking(ctx.hookContext, text, round, provider);
    };
  }

  /**
   * Send one round's thinking as its own message. Failures are swallowed: thinking
   * is diagnostic output and losing it must never cost the user their actual reply.
   */
  private async sendThinking(
    context: HookContext,
    text: string,
    round: number,
    provider: string | undefined,
  ): Promise<void> {
    try {
      const body =
        text.length > MAX_THINKING_CHARS
          ? `${text.slice(0, MAX_THINKING_CHARS)}\n…（已截断，完整内容见 llm-dump）`
          : text;
      const segments = new MessageBuilder().text(`💭 思考 #${round}（${provider ?? 'unknown'}）\n\n${body}`).build();
      const botSelfId = Number(context.metadata.get('botSelfId'));

      if (!Number.isNaN(botSelfId) && botSelfId > 0) {
        await this.messageAPI.sendForwardFromContext([{ segments, senderName: '思考过程' }], context.message, 30_000, {
          botUserId: botSelfId,
        });
      } else {
        // Forward nodes need the bot's own id; without it a plain message still
        // delivers the thinking rather than dropping it.
        await this.messageAPI.sendFromContext(segments, context.message, 30_000);
      }
      logger.debug(`[GenerationStage] Sent thinking #${round} (${text.length} chars)`);
    } catch (err) {
      logger.warn(`[GenerationStage] Failed to send thinking #${round}:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Single attempt
  // ---------------------------------------------------------------------------

  private async attemptLLMGeneration(
    context: HookContext,
    params: GenerationPipelineParams,
  ): Promise<GenerationPipelineResult> {
    const { messages, genOptions, toolDefinitions, selectedProviderName, effectiveNativeSearchEnabled, onReasoning } =
      params;

    // Reset per-attempt so retries with fallback providers start clean.
    context.metadata.delete('cardSent');
    context.metadata.delete('cardSendFailedReason');

    // Stamp the active provider so tool executors (notably send_card) can
    // attribute their output to whoever is actually generating this turn.
    // Without this, send_card falls back to the global default LLM provider
    // and the card footer shows the wrong name when the requested provider
    // was overridden upstream (e.g. `claude:` prefix → anthropic).
    if (selectedProviderName) {
      context.metadata.set('activeProvider', selectedProviderName);
    } else {
      context.metadata.delete('activeProvider');
    }
    // The real model is only known once a round runs (provider fallback); cleared
    // here and filled by onProviderResolved before any mid-loop tool renders.
    context.metadata.delete('activeModel');

    const toolExecutor = (call: { name: string; arguments: string }) =>
      executeSkillCall(call, context, this.toolManager, this.hookManager);

    const r = await this.llmService.generateWithTools(
      messages,
      toolDefinitions,
      {
        temperature: genOptions.temperature,
        maxTokens: genOptions.maxTokens,
        maxToolRounds: 4,
        sessionId: genOptions.sessionId,
        reasoningEffort: genOptions.reasoningEffort,
        nativeWebSearch: effectiveNativeSearchEnabled,
        toolExecutor,
        onReasoning,
        onProviderResolved: ({ providerName, model }) => {
          context.metadata.set('activeProvider', providerName);
          if (model) context.metadata.set('activeModel', model);
        },
      },
      selectedProviderName,
    );

    // Stamp per-user usage onto the context so the onAIGenerationComplete hook
    // handler can record it. r.usage is the summed total across all tool rounds.
    const actualProvider = r.resolvedProviderName ?? selectedProviderName;
    const actualModel = r.resolvedModel ?? context.metadata.get('activeModel');
    if (r.usage && actualProvider) {
      context.metadata.set('aiUsage', {
        type: 'llm',
        provider: actualProvider,
        model: actualModel,
        source: 'reply',
        promptTokens: r.usage.promptTokens,
        completionTokens: r.usage.completionTokens,
        totalTokens: r.usage.totalTokens,
      });
    }

    return {
      response: { text: r.text, resolvedProviderName: r.resolvedProviderName },
      actualProvider,
    };
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
      const primaryProviderLabel = params.selectedProviderName ?? 'default';
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

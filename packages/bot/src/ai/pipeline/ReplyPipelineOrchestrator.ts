// Reply generation pipeline orchestrator.
// Runs the stage-based pipeline for normal reply generation.

import { inject, singleton } from 'tsyringe';
import { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
import { EpisodeCacheManager } from '@/ai/pipeline/helpers/EpisodeCacheManager';
import { ContextEnrichmentStage } from '@/ai/pipeline/stages/ContextEnrichmentStage';
import { ContextResolutionStage } from '@/ai/pipeline/stages/ContextResolutionStage';
import { GateCheckStage } from '@/ai/pipeline/stages/GateCheckStage';
import { GenerationStage } from '@/ai/pipeline/stages/GenerationStage';
import { HistoryStage } from '@/ai/pipeline/stages/HistoryStage';
import { PromptAssemblyStage } from '@/ai/pipeline/stages/PromptAssemblyStage';
import { ProviderSelectionStage } from '@/ai/pipeline/stages/ProviderSelectionStage';
import { ResponseDispatchStage } from '@/ai/pipeline/stages/ResponseDispatchStage';
import { replaceReply } from '@/context/HookContextHelpers';
import { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import type { ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import { ReplyPipelineContext } from './ReplyPipelineContext';
import type { ReplyStage } from './types';

/**
 * Reply generation pipeline orchestrator.
 * Executes a sequence of {@link ReplyStage} instances to produce a reply,
 * with early exit when a stage sets `ctx.interrupted = true`.
 * Also exposes the card-reply public API for proactive/external callers.
 */
@singleton()
export class ReplyPipelineOrchestrator {
  private readonly stages: ReplyStage[];

  constructor(
    @inject(EpisodeCacheManager) private episodeCacheManager: EpisodeCacheManager,
    @inject(CardRenderingHelper) private cardHelper: CardRenderingHelper,
    @inject(HookManager) private hookManager: HookManager,
    // The stages run in exactly this order.
    @inject(GateCheckStage) gateCheck: GateCheckStage,
    @inject(ContextResolutionStage) contextResolution: ContextResolutionStage,
    @inject(HistoryStage) history: HistoryStage,
    @inject(ContextEnrichmentStage) contextEnrichment: ContextEnrichmentStage,
    @inject(ProviderSelectionStage) providerSelection: ProviderSelectionStage,
    @inject(PromptAssemblyStage) promptAssembly: PromptAssemblyStage,
    @inject(GenerationStage) generation: GenerationStage,
    @inject(ResponseDispatchStage) responseDispatch: ResponseDispatchStage,
  ) {
    this.stages = [
      gateCheck,
      contextResolution,
      history,
      contextEnrichment,
      providerSelection,
      promptAssembly,
      generation,
      responseDispatch,
    ];
  }

  // ---------------------------------------------------------------------------
  // Main entry: normal reply pipeline
  // ---------------------------------------------------------------------------

  /**
   * Generate reply from task results (unified entry for ReplySystem / ReplyToolExecutor).
   */
  async generateReplyFromToolResults(context: HookContext, taskResults: Map<string, ToolResult>): Promise<void> {
    const ctx = new ReplyPipelineContext(context, taskResults);

    try {
      for (const stage of this.stages) {
        if (ctx.interrupted) return;
        await stage.execute(ctx);
      }
      // Fire-and-forget episode maintenance
      void this.episodeCacheManager.maintainEpisodeContext(ctx.episodeKey).catch(() => {});
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ReplyPipelineOrchestrator] Failed to generate reply from task results:', err);
      await this.hookManager.execute('onAIGenerationComplete', context);

      const errorMessage = `抱歉，AI 回复生成失败：${err.message || '未知错误'}。请稍后再试。`;
      replaceReply(context, errorMessage, 'ai');
    }
  }

  // ---------------------------------------------------------------------------
  // Card reply public API (for external callers like AIService/proactive flow)
  // ---------------------------------------------------------------------------

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
    if (options?.context != null) {
      return this.cardHelper.handleCardReplyWithContext(responseText, sessionId, options.context, options.providerName);
    }
    return this.cardHelper.handleCardReplyWithoutContext(responseText, sessionId, options?.providerName);
  }
}

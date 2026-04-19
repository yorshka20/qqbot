// LLMStage — the actual round-trip.
//
// Picks the provider from the bot's default LLM config (falls back to
// 'deepseek' when unconfigured — historical default from AvatarCommandHandler)
// and calls `llmService.generate` with a small, tightly-capped request:
// `maxTokens=256`, `temperature=0.8`. Avatar replies are intentionally
// short and stylized; expanding the cap here is unlikely to help and more
// likely to produce rambly TTS output.
//
// Future enhancements (natural fit here):
//   - Per-source provider routing (batch could use a cheaper model)
//   - Retry + fallback across providers on 5xx / quota errors
//   - Response caching keyed on (systemPrompt, userText)
//   - Streaming token output into the speech pipeline for lower latency

import { inject, injectable } from 'tsyringe';
import type { LLMService } from '@/ai/services/LLMService';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { Live2DContext, Live2DStage } from '../Live2DStage';

const DEFAULT_PROVIDER = 'deepseek';
const MAX_TOKENS = 256;
const TEMPERATURE = 0.8;

@injectable()
export class LLMStage implements Live2DStage {
  readonly name = 'llm';

  constructor(
    @inject(DITokens.LLM_SERVICE) private llmService: LLMService,
    @inject(DITokens.CONFIG) private config: Config,
  ) {}

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.systemPrompt) {
      // PromptAssemblyStage must have run first; defense-in-depth.
      ctx.skipped = true;
      ctx.skipReason = 'prompt-render-failed';
      return;
    }

    ctx.providerName = this.resolveProvider();

    try {
      const response = await this.llmService.generate(
        ctx.input.text,
        {
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          messages: [
            { role: 'system', content: ctx.systemPrompt },
            { role: 'user', content: ctx.input.text },
          ],
        },
        ctx.providerName,
      );
      ctx.replyText = (response.text ?? '').trim();
    } catch (err) {
      logger.warn(
        `[Live2D/llm] generation failed (source=${ctx.input.source} provider=${ctx.providerName}):`,
        err,
      );
      ctx.skipped = true;
      ctx.skipReason = 'llm-failed';
      return;
    }

    if (!ctx.replyText || ctx.replyText.length === 0) {
      ctx.skipped = true;
      ctx.skipReason = 'empty-reply';
    }
  }

  private resolveProvider(): string {
    return this.config.getAIConfig()?.defaultProviders?.llm ?? DEFAULT_PROVIDER;
  }
}

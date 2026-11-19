// Sail Research: an OpenAI-compatible host serving DeepSeek (and other open) models.

import type { AIGenerateOptions } from '../types';
import {
  type ChatCompletionUsage,
  DeepSeekChatProvider,
  type DeepSeekChatProviderConfig,
} from './DeepSeekChatProvider';

export type SailProviderConfig = DeepSeekChatProviderConfig;

/**
 * Sail's /chat/completions (https://docs.sailresearch.com). Requests run on the `asap` tier,
 * the default when no `service_tier` is sent: the cheaper `balanced` / `flex` tiers queue the
 * first turn for minutes to an hour, and Chat Completions rejects `flex` outright.
 */
export class SailProvider extends DeepSeekChatProvider {
  readonly name = 'sail';
  override readonly isRelay = true;

  constructor(config: SailProviderConfig) {
    super(config, {
      baseURL: 'https://api.sailresearch.com/v1',
      defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      capabilities: ['llm', 'function_calling', 'vision'],
    });
  }

  /**
   * Sail rejects `max_tokens` (it takes `max_completion_tokens`) and does not support `stop`,
   * `frequency_penalty` or `presence_penalty`, so those are never sent.
   */
  protected applyGenerationParams(body: Record<string, unknown>, options: AIGenerateOptions | undefined): void {
    body.max_completion_tokens = this.resolveMaxTokens(options);
    body.top_p = options?.topP;
    const effort = this.resolveReasoningEffort(options);
    if (effort) {
      body.reasoning_effort = effort;
    }
  }

  protected cachedPromptTokens(usage: ChatCompletionUsage): number | undefined {
    return usage.prompt_tokens_details?.cached_tokens;
  }
}

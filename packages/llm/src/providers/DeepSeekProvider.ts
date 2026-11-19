// DeepSeek Provider implementation (DeepSeek's own API)

import type { AIGenerateOptions } from '../types';
import {
  type ChatCompletionUsage,
  DeepSeekChatProvider,
  type DeepSeekChatProviderConfig,
} from './DeepSeekChatProvider';

export type DeepSeekProviderConfig = DeepSeekChatProviderConfig;

/**
 * DeepSeek's first-party API (https://api-docs.deepseek.com/api/create-chat-completion).
 * Implements LLM and Vision capabilities.
 */
export class DeepSeekProvider extends DeepSeekChatProvider {
  readonly name = 'deepseek';

  constructor(config: DeepSeekProviderConfig) {
    super(config, {
      baseURL: 'https://api.deepseek.com',
      defaultModel: 'deepseek-chat',
      capabilities: ['llm', 'function_calling', 'vision'],
    });
  }

  protected applyGenerationParams(body: Record<string, unknown>, options: AIGenerateOptions | undefined): void {
    body.max_tokens = this.resolveMaxTokens(options);
    body.top_p = options?.topP;
    body.frequency_penalty = options?.frequencyPenalty;
    body.presence_penalty = options?.presencePenalty;
    body.stop = options?.stop;
    const effort = this.resolveReasoningEffort(options);
    if (effort) {
      body.reasoning_effort = effort;
    }
  }

  protected cachedPromptTokens(usage: ChatCompletionUsage): number | undefined {
    return usage.prompt_cache_hit_tokens;
  }
}

// DeepInfra: an OpenAI-compatible host serving DeepSeek (and other open) models, with a batch API.

import type { AIGenerateOptions } from '../types';
import {
  type ChatCompletionUsage,
  DeepSeekChatProvider,
  type DeepSeekChatProviderConfig,
} from './DeepSeekChatProvider';

export type DeepInfraProviderConfig = DeepSeekChatProviderConfig;

/** DeepInfra's OpenAI-compatible /chat/completions (https://docs.deepinfra.com/chat/overview). */
export class DeepInfraProvider extends DeepSeekChatProvider {
  readonly name = 'deepinfra';
  override readonly isRelay = true;

  constructor(config: DeepInfraProviderConfig) {
    super(config, {
      baseURL: 'https://api.deepinfra.com/v1/openai',
      defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      capabilities: ['llm', 'function_calling', 'vision'],
    });
  }

  /** The base URL batch files and jobs live under — the same API root as chat. */
  get apiBaseURL(): string {
    return this.baseUrl;
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
    return usage.prompt_tokens_details?.cached_tokens;
  }
}

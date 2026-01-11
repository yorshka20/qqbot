// OpenAI Provider implementation

import { logger } from '@/utils/logger';
import OpenAI from 'openai';
import { AIProvider } from '../base/AIProvider';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  StreamingHandler,
} from '../types';

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

/**
 * OpenAI Provider implementation
 */
export class OpenAIProvider extends AIProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    super();
    this.config = config;

    if (this.isAvailable()) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });
      logger.info('[OpenAIProvider] Initialized');
    }
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'gpt-3.5-turbo',
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  async generate(
    prompt: string,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = (this.config.model || 'gpt-3.5-turbo') as string;
    const temperature =
      options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens =
      options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OpenAIProvider] Generating with model: ${model}`);

      const response = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
      });

      const text = response.choices[0]?.message?.content || '';
      const usage = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      return {
        text,
        usage,
        metadata: {
          model: response.model,
          finishReason: response.choices[0]?.finish_reason,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = (this.config.model || 'gpt-3.5-turbo') as string;
    const temperature =
      options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens =
      options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OpenAIProvider] Generating stream with model: ${model}`);

      const stream = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
      });

      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullText += content;
          handler(content);
        }

        // Capture usage if available
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }

      return {
        text: fullText,
        usage,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Stream generation failed:', err);
      throw err;
    }
  }
}

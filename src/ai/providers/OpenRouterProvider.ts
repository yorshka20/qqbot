// OpenRouter Provider implementation

import { HttpClient } from '@/api/http/HttpClient';
import type { OpenRouterProviderConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType } from '../capabilities/types';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';

/**
 * OpenRouter Provider implementation
 * Implements LLM capability
 * Supports multiple models through OpenRouter aggregation platform
 */
export class OpenRouterProvider extends AIProvider implements LLMCapability {
  readonly name = 'openrouter';
  private httpClient: HttpClient;
  private config: OpenRouterProviderConfig;
  private _capabilities: CapabilityType[];

  constructor(config: OpenRouterProviderConfig) {
    super();
    this.config = config;

    // Explicitly declare supported capabilities
    this._capabilities = ['llm'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    // Configure HttpClient
    const baseURL = config.baseURL || 'https://openrouter.ai/api/v1';
    const defaultHeaders: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
    };

    // Add optional headers for rankings
    if (config.httpReferer) {
      defaultHeaders['HTTP-Referer'] = config.httpReferer;
    }
    if (config.siteName) {
      defaultHeaders['X-Title'] = config.siteName;
    }

    this.httpClient = new HttpClient({
      baseURL,
      defaultHeaders,
      defaultTimeout: 60000, // 60 seconds default timeout
    });

    if (this.isAvailable()) {
      logger.info('[OpenRouterProvider] Initialized');
    }
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      // Test API connection by making a simple request
      await this.httpClient.post('/chat/completions', {
        model: this.config.model || 'openai/gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      });
      return true;
    } catch (error) {
      logger.debug('[OpenRouterProvider] Availability check failed:', error);
      // Even if the request fails, if we get a response, the API is reachable
      // Only return false if it's a network error
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      // Other errors (like 401) mean the API is reachable but credentials might be wrong
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'openai/gpt-3.5-turbo',
      defaultTemperature: this.config.temperature || 0.7,
      defaultMaxTokens: this.config.maxTokens || 2000,
    };
  }

  /**
   * Get capabilities supported by this provider
   * OpenRouter supports LLM text generation
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    const model = this.config.model || 'openai/gpt-3.5-turbo';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 2000;

    try {
      logger.debug(`[OpenRouterProvider] Generating with model: ${model}`);

      // Load conversation history if context is enabled
      const history = await this.loadHistory(options);
      const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

      // Add history messages
      for (const msg of history) {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
          content: msg.content,
        });
      }

      // Add current user message
      messages.push({
        role: 'user',
        content: prompt,
      });

      const response = await this.httpClient.post<{
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        model: string;
      }>('/chat/completions', {
        model,
        messages,
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
      logger.error('[OpenRouterProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = this.config.model || 'openai/gpt-3.5-turbo';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 2000;

    try {
      logger.debug(`[OpenRouterProvider] Generating stream with model: ${model}`);

      // Load conversation history if context is enabled
      const history = await this.loadHistory(options);
      const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

      // Add history messages
      for (const msg of history) {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
          content: msg.content,
        });
      }

      // Add current user message
      messages.push({
        role: 'user',
        content: prompt,
      });

      // Use streaming endpoint
      const stream = await this.httpClient.stream('/chat/completions', {
        method: 'POST',
        body: {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          top_p: options?.topP,
          frequency_penalty: options?.frequencyPenalty,
          presence_penalty: options?.presencePenalty,
          stop: options?.stop,
          stream: true,
        },
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter((line: string) => line.trim() && line.startsWith('data: '));

          for (const line of lines) {
            try {
              const jsonStr = line.substring(6); // Remove 'data: ' prefix
              if (jsonStr === '[DONE]') {
                continue;
              }

              const data = JSON.parse(jsonStr) as {
                choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
              };

              if (data.choices?.[0]?.delta?.content) {
                fullText += data.choices[0].delta.content;
                handler(data.choices[0].delta.content);
              }

              // Capture usage if available
              if (data.usage) {
                usage = {
                  promptTokens: data.usage.prompt_tokens,
                  completionTokens: data.usage.completion_tokens,
                  totalTokens: data.usage.total_tokens,
                };
              }
            } catch (parseError) {
              logger.debug('[OpenRouterProvider] Failed to parse stream chunk:', parseError);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return {
        text: fullText,
        usage,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenRouterProvider] Stream generation failed:', err);
      throw err;
    }
  }
}

// Ollama Provider implementation

import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType } from '../capabilities/types';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';

export interface OllamaProviderConfig {
  baseUrl: string;
  model: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
}

interface OllamaGenerateResponse {
  message?: { content?: string; role?: string };
  model?: string;
  done?: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

/**
 * Ollama Provider implementation
 * Supports local Ollama API (typically http://localhost:11434)
 * Implements LLM capability for text generation
 */
export class OllamaProvider extends AIProvider implements LLMCapability {
  readonly name = 'ollama';
  private config: OllamaProviderConfig;
  private baseUrl: string;
  private _capabilities: CapabilityType[];

  constructor(config: OllamaProviderConfig) {
    super();
    this.config = config;
    // Normalize base URL (remove trailing slash)
    this.baseUrl = config.baseUrl.replace(/\/$/, '');

    // Explicitly declare supported capabilities
    this._capabilities = ['llm'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    if (this.isAvailable()) {
      logger.info('[OllamaProvider] Initialized');
    }
  }

  isAvailable(): boolean {
    return !!this.config.baseUrl && !!this.config.model;
  }

  getConfig(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      model: this.config.model,
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  /**
   * Get capabilities supported by this provider
   * Ollama supports LLM text generation
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Check if Ollama server is available
   */
  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      return response.ok;
    } catch (error) {
      logger.debug('[OllamaProvider] Availability check failed:', error);
      return false;
    }
  }

  /**
   * Build messages array from history and current prompt
   * Always builds messages array (even if context is disabled, we still use chat API for consistency)
   */
  private async buildMessages(
    prompt: string,
    options?: AIGenerateOptions,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Load conversation history if context is enabled
    if (this.enableContext) {
      const history = await this.loadHistory(options);
      // Add history messages
      for (const msg of history) {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    // Add current user message
    messages.push({
      role: 'user',
      content: prompt,
    });

    return messages;
  }

  /**
   * Call Ollama chat API
   */
  private async callChatAPI(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: AIGenerateOptions,
    stream = false,
  ): Promise<Response> {
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    return fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        options: {
          temperature,
          num_predict: maxTokens,
          top_p: options?.topP,
          repeat_penalty: options?.frequencyPenalty ? 1 + options.frequencyPenalty : undefined,
        },
        stream,
      }),
    });
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    try {
      logger.debug(`[OllamaProvider] Generating with model: ${this.config.model}`);

      // Always use chat API - it supports both single messages and conversation history
      // This simplifies the code and makes it consistent with other providers
      const messages = await this.buildMessages(prompt, options);
      const response = await this.callChatAPI(messages, options, false);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      const text = data.message?.content ?? '';
      const usage = data.eval_count
        ? {
            promptTokens: data.prompt_eval_count || 0,
            completionTokens: data.eval_count || 0,
            totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
          }
        : undefined;

      return {
        text,
        usage,
        metadata: {
          model: data.model || this.config.model,
          done: data.done,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OllamaProvider] Generation failed:', err);
      throw err;
    }
  }

  /**
   * Parse streaming response from chat API
   */
  private async parseChatStream(
    response: Response,
    handler: StreamingHandler,
  ): Promise<{ text: string; usage?: AIGenerateResponse['usage'] }> {
    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
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
        const lines = chunk.split('\n').filter((line) => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line) as OllamaGenerateResponse;
            const content = data.message?.content ?? '';
            if (content) {
              fullText += content;
              handler(content);
            }

            // Capture usage if available and done
            if (data.done && data.eval_count) {
              usage = {
                promptTokens: data.prompt_eval_count || 0,
                completionTokens: data.eval_count || 0,
                totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
              };
            }
          } catch (parseError) {
            logger.debug('[OllamaProvider] Failed to parse stream chunk:', parseError);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { text: fullText, usage };
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    try {
      logger.debug(`[OllamaProvider] Generating stream with model: ${this.config.model}`);

      // Always use chat API - it supports both single messages and conversation history
      // This simplifies the code and makes it consistent with other providers
      const messages = await this.buildMessages(prompt, options);
      const response = await this.callChatAPI(messages, options, true);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

      const { text, usage } = await this.parseChatStream(response, handler);
      return { text, usage };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OllamaProvider] Stream generation failed:', err);
      throw err;
    }
  }
}

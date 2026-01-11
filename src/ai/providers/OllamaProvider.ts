// Ollama Provider implementation

import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  StreamingHandler,
} from '../types';

export interface OllamaProviderConfig {
  baseUrl: string;
  model: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

interface OllamaGenerateResponse {
  response?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  model?: string;
  done?: boolean;
}

/**
 * Ollama Provider implementation
 * Supports local Ollama API (typically http://localhost:11434)
 */
export class OllamaProvider extends AIProvider {
  readonly name = 'ollama';
  private config: OllamaProviderConfig;
  private baseUrl: string;

  constructor(config: OllamaProviderConfig) {
    super();
    this.config = config;
    // Normalize base URL (remove trailing slash)
    this.baseUrl = config.baseUrl.replace(/\/$/, '');

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
   * Check if Ollama server is available
   */
  async checkAvailability(): Promise<boolean> {
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

  async generate(
    prompt: string,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = this.config.model;
    const temperature =
      options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens =
      options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OllamaProvider] Generating with model: ${model}`);

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          options: {
            temperature,
            num_predict: maxTokens,
            top_p: options?.topP,
            repeat_penalty: options?.frequencyPenalty
              ? 1 + options.frequencyPenalty
              : undefined,
          },
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      const text = data.response || '';
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
          model: data.model || model,
          done: data.done,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OllamaProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = this.config.model;
    const temperature =
      options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens =
      options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OllamaProvider] Generating stream with model: ${model}`);

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          options: {
            temperature,
            num_predict: maxTokens,
            top_p: options?.topP,
            repeat_penalty: options?.frequencyPenalty
              ? 1 + options.frequencyPenalty
              : undefined,
          },
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} ${errorText}`);
      }

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
              const content = data.response || '';
              if (content) {
                fullText += content;
                handler(content);
              }

              // Capture usage if available and done
              if (data.done && data.eval_count) {
                usage = {
                  promptTokens: data.prompt_eval_count || 0,
                  completionTokens: data.eval_count || 0,
                  totalTokens:
                    (data.prompt_eval_count || 0) + (data.eval_count || 0),
                };
              }
            } catch (parseError) {
              // Skip invalid JSON lines
              logger.debug(
                '[OllamaProvider] Failed to parse stream chunk:',
                parseError,
              );
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
      logger.error('[OllamaProvider] Stream generation failed:', err);
      throw err;
    }
  }
}

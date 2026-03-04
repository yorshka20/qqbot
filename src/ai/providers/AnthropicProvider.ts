// Anthropic Provider implementation

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';
import { ResourceDownloader } from '../utils/ResourceDownloader';

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string; // claude-3-opus, claude-3-sonnet, claude-3-haiku, etc.
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
  resourceSavePath?: string; // Directory path to save downloaded resources
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<{ type: 'text' | 'image'; text?: string; source?: { type: string; media_type: string; data: string } }>;
}

interface AnthropicMessagesRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: AnthropicMessage[];
  system?: string;
}

interface AnthropicStreamRequestBody extends AnthropicMessagesRequestBody {
  stream: true;
}

interface AnthropicVisionRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: 'user'; content: AnthropicMessage['content'] }>;
  system?: string;
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text: string }>;
  usage?: { input_tokens: number; output_tokens: number };
  model: string;
}

interface AnthropicStreamChunk {
  type: string;
  delta?: { text?: string };
  usage?: { input_tokens: number; output_tokens: number };
}

function isAnthropicStreamChunk(value: unknown): value is AnthropicStreamChunk {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof Reflect.get(value, 'type') === 'string';
}

/**
 * Anthropic Provider implementation
 * Implements LLM and Vision capabilities
 * Supports Claude 3 models with vision support
 */
export class AnthropicProvider extends AIProvider implements LLMCapability, VisionCapability {
  readonly name = 'anthropic';
  private config: AnthropicProviderConfig;
  private baseUrl = 'https://api.anthropic.com/v1';
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.config = config;

    // Explicitly declare supported capabilities
    // Anthropic Claude 3 supports both LLM and Vision
    this._capabilities = ['llm', 'vision'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    // Configure HttpClient
    this.httpClient = new HttpClient({
      baseURL: this.baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      defaultTimeout: 120000, // 2 minutes default timeout for AI processing
    });

    if (this.isAvailable()) {
      logger.info('[AnthropicProvider] Initialized');
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
      await this.httpClient.post(
        '/messages',
        {
          model: this.config.model || 'claude-3-sonnet-20240229',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
        },
        { timeout: 5000 },
      );
      return true;
    } catch (error) {
      logger.debug('[AnthropicProvider] Availability check failed:', error);
      // If we get a 401 or 400, the API is reachable but token/request might be invalid
      // If we get a network error, the API is not reachable
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      // Other errors (like 401, 400) mean the API is reachable
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'claude-3-sonnet-20240229',
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  /**
   * Get capabilities supported by this provider
   * Anthropic Claude 3 supports LLM text generation and Vision (multimodal)
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    const model = this.config.model || 'claude-3-sonnet-20240229';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[AnthropicProvider] Generating with model: ${model}`);

      let messages: AnthropicMessage[];
      if (options?.messages?.length) {
        messages = options.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      const requestBody: AnthropicMessagesRequestBody = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages,
      };
      const explicitSystem = options?.messages?.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      if (explicitSystem?.trim()) {
        requestBody.system = explicitSystem;
      } else if (options?.systemPrompt) {
        requestBody.system = options.systemPrompt;
      }

      const data = await this.httpClient.post<AnthropicMessagesResponse>('/messages', requestBody);

      const text = data.content[0]?.text || '';
      const usage = data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined;

      return {
        text,
        usage,
        metadata: {
          model: data.model,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AnthropicProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = this.config.model || 'claude-3-sonnet-20240229';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[AnthropicProvider] Generating stream with model: ${model}`);

      let messages: AnthropicMessage[];
      if (options?.messages?.length) {
        messages = options.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      // Use HttpClient stream method for streaming requests
      const requestBody: AnthropicStreamRequestBody = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages,
        stream: true,
      };
      const explicitSystem = options?.messages?.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      if (explicitSystem?.trim()) {
        requestBody.system = explicitSystem;
      } else if (options?.systemPrompt) {
        requestBody.system = options.systemPrompt;
      }

      const stream = await this.httpClient.stream('/messages', {
        method: 'POST',
        body: requestBody,
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
          const lines = chunk.split('\n').filter((line) => line.trim() && line.startsWith('data: '));

          for (const line of lines) {
            try {
              const jsonStr = line.substring(6); // Remove 'data: ' prefix
              if (jsonStr === '[DONE]') {
                continue;
              }

              const parsed = JSON.parse(jsonStr);
              if (!isAnthropicStreamChunk(parsed)) {
                continue;
              }

              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                fullText += parsed.delta.text;
                handler(parsed.delta.text);
              }

              if (parsed.type === 'message_stop' && parsed.usage) {
                usage = {
                  promptTokens: parsed.usage.input_tokens,
                  completionTokens: parsed.usage.output_tokens,
                  totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
                };
              }
            } catch (parseError) {
              logger.debug('[AnthropicProvider] Failed to parse stream chunk:', parseError);
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
      logger.error('[AnthropicProvider] Stream generation failed:', err);
      throw err;
    }
  }

  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = this.config.model || 'claude-3-opus-20240229';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[AnthropicProvider] Generating with vision, model: ${model}`);

      // Build content array with text and images
      const content: Array<{
        type: 'text' | 'image';
        text?: string;
        source?: { type: string; media_type: string; data: string };
      }> = [{ type: 'text', text: prompt }];

      // Add images to content
      for (const image of images) {
        let imageData: string;
        const mimeType = image.mimeType || 'image/jpeg';

        // Use ResourceDownloader to handle various input formats
        if (image.base64) {
          imageData = image.base64;
        } else if (image.url) {
          // Download from URL and convert to base64
          // Anthropic API limit: 5MB per image, 32MB per request
          imageData = await ResourceDownloader.downloadToBase64(image.url, {
            timeout: 30000, // 30 seconds timeout
            maxSize: 5 * 1024 * 1024, // 5MB maximum (Anthropic API limit)
            savePath: this.config.resourceSavePath, // Use provider-specific save path if configured
            filename: `anthropic_image_${Date.now()}`,
          });
        } else if (image.file) {
          // Read file and convert to base64
          // Anthropic API limit: 5MB per image, 32MB per request
          imageData = await ResourceDownloader.downloadToBase64(image.file, {
            timeout: 5000, // 5 seconds for local file
            maxSize: 5 * 1024 * 1024, // 5MB maximum (Anthropic API limit)
            savePath: this.config.resourceSavePath, // Use provider-specific save path if configured
            filename: `anthropic_image_${Date.now()}`,
          });
        } else {
          throw new Error('Invalid image format. Must provide base64, url, or file.');
        }

        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: imageData,
          },
        });
      }

      const requestBody: AnthropicVisionRequestBody = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      };
      if (options?.systemPrompt) {
        requestBody.system = options.systemPrompt;
      }

      const data = await this.httpClient.post<AnthropicMessagesResponse>('/messages', requestBody);

      const text = data.content[0]?.text || '';
      const usage = data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined;

      return {
        text,
        usage,
        metadata: {
          model: data.model,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AnthropicProvider] Vision generation failed:', err);
      throw err;
    }
  }

  /**
   * Explain image(s): describe image content as text. Prompt is the full rendered text from the dedicated explain-image template.
   */
  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    // Similar to generateWithVision but with streaming
    // Implementation would be similar to generateStream but with image content
    // For brevity, we'll use the non-streaming version and convert
    const response = await this.generateWithVision(prompt, images, options);
    // In a real implementation, you would stream the response
    handler(response.text);
    return response;
  }
}

// OpenAI Provider implementation

import OpenAI from 'openai';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatCompletionMessageParam,
  ChatMessage,
  StreamingHandler,
} from '../types';

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
}

/**
 * OpenAI Provider implementation
 * Implements LLM and Vision capabilities
 * Supports GPT-4 Vision models for multimodal input
 */
export class OpenAIProvider extends AIProvider implements LLMCapability, VisionCapability {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private config: OpenAIProviderConfig;
  private _capabilities: CapabilityType[];

  constructor(config: OpenAIProviderConfig) {
    super();
    this.config = config;

    // Explicitly declare supported capabilities
    // OpenAI supports both LLM and Vision (GPT-4 Vision models)
    this._capabilities = ['llm', 'vision'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

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

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable() || !this.client) {
      return false;
    }

    try {
      // Test API connection by making a simple request
      await this.client.models.list();
      return true;
    } catch (error) {
      logger.debug('[OpenAIProvider] Availability check failed:', error);
      return false;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'gpt-3.5-turbo',
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  /**
   * Get capabilities supported by this provider
   * OpenAI supports LLM text generation and Vision (multimodal)
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = this.config.model || 'gpt-3.5-turbo';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OpenAIProvider] Generating with model: ${model}`);

      let messages: ChatCompletionMessageParam[];
      if (options?.messages?.length) {
        messages = options.messages.map((m) => ({ role: m.role, content: m.content })) as ChatCompletionMessageParam[];
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        if (options?.systemPrompt) {
          messages.push({ role: 'system', content: options.systemPrompt });
        }
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
            content: msg.content,
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      const response = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
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

    const model = this.config.model || 'gpt-3.5-turbo';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OpenAIProvider] Generating stream with model: ${model}`);

      let messages: ChatCompletionMessageParam[];
      if (options?.messages?.length) {
        messages = options.messages.map((m) => ({ role: m.role, content: m.content })) as ChatCompletionMessageParam[];
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        if (options?.systemPrompt) {
          messages.push({ role: 'system', content: options.systemPrompt });
        }
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
            content: msg.content,
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      const stream = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
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

  /**
   * Generate from full messages (history + current). Content can be string or ContentPart[].
   */
  async generateWithVisionMessages(messages: ChatMessage[], options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }
    const model = this.config.model || 'gpt-4-vision-preview';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const apiMessages = messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>),
    })) as ChatCompletionMessageParam[];
    const response = await this.client.chat.completions.create({
      model,
      messages: apiMessages,
      temperature,
      max_completion_tokens: maxTokens,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty,
      stop: options?.stop,
    });
    const text = response.choices[0]?.message?.content || '';
    return {
      text,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      metadata: {
        model: response.model,
        finishReason: response.choices[0]?.finish_reason,
      },
    };
  }

  /**
   * Generate text with vision (multimodal input)
   * Supports GPT-4 Vision models
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = this.config.model || 'gpt-4-vision-preview';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OpenAIProvider] Generating with vision, model: ${model}`);

      // Build content array with text and images
      const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: prompt },
      ];

      // Add images to content
      for (const image of images) {
        let imageUrl: string;
        if (image.url) {
          imageUrl = image.url;
        } else if (image.base64) {
          // Convert base64 to data URL
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.file) {
          // For file paths, we need to convert to base64 or URL
          // This is a simplified version - in production, you might want to handle file uploads
          throw new Error('File path images not directly supported. Please use URL or base64.');
        } else {
          throw new Error('Invalid image format. Must provide url, base64, or file.');
        }

        content.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }

      const messages: Array<
        | { role: 'system'; content: string }
        | {
            role: 'user';
            content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
          }
      > = [];
      if (options?.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({
        role: 'user',
        content,
      });

      const response = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
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
      logger.error('[OpenAIProvider] Vision generation failed:', err);
      throw err;
    }
  }

  /**
   * Explain image(s): describe image content as text. Prompt is the full rendered text from the dedicated explain-image template.
   */
  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  /**
   * Generate text with vision and streaming support
   */
  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = this.config.model || 'gpt-4-vision-preview';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[OpenAIProvider] Generating stream with vision, model: ${model}`);

      // Build content array with text and images
      const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: prompt },
      ];

      // Add images to content
      for (const image of images) {
        let imageUrl: string;
        if (image.url) {
          imageUrl = image.url;
        } else if (image.base64) {
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.file) {
          throw new Error('File path images not directly supported. Please use URL or base64.');
        } else {
          throw new Error('Invalid image format. Must provide url, base64, or file.');
        }

        content.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }

      const messages: Array<
        | { role: 'system'; content: string }
        | {
            role: 'user';
            content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
          }
      > = [];
      if (options?.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({
        role: 'user',
        content,
      });

      const stream = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
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
      logger.error('[OpenAIProvider] Vision stream generation failed:', err);
      throw err;
    }
  }
}

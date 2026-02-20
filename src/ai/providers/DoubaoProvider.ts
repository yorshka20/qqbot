// Doubao Provider implementation

import { logger } from '@/utils/logger';
import OpenAI from 'openai';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';

// Extended types for Doubao API with reasoning_effort and reasoning_content support
// Note: reasoning_effort is a Doubao-specific parameter not in OpenAI types
// reasoning_content appears in response messages and stream deltas
type DoubaoChatCompletionMessage = OpenAI.Chat.Completions.ChatCompletionMessage & {
  reasoning_content?: string;
};

type DoubaoChatCompletionDelta = {
  role?: 'assistant';
  content?: string;
  reasoning_content?: string;
};

export interface DoubaoProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
}

/**
 * Doubao Provider implementation
 * Implements LLM and Vision capabilities
 * Supports Doubao API with reasoning_effort parameter and reasoning_content response
 */
export class DoubaoProvider extends AIProvider implements LLMCapability, VisionCapability {
  readonly name = 'doubao';
  private client: OpenAI | null = null;
  private config: DoubaoProviderConfig;
  private _capabilities: CapabilityType[];

  constructor(config: DoubaoProviderConfig) {
    super();
    this.config = config;

    // Explicitly declare supported capabilities
    // Doubao supports both LLM and Vision
    this._capabilities = ['llm', 'vision'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    if (this.isAvailable()) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL || 'https://ark.cn-beijing.volces.com/api/v3',
      });
      logger.info('[DoubaoProvider] Initialized');
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
      logger.debug('[DoubaoProvider] Availability check failed:', error);
      return false;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'doubao-seed-1-6-lite-251015',
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
      reasoningEffort: this.config.reasoningEffort || 'medium',
    };
  }

  /**
   * Get capabilities supported by this provider
   * Doubao supports LLM text generation and Vision (multimodal)
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const reasoningEffort = options?.reasoningEffort ?? this.config.reasoningEffort ?? 'medium';

    try {
      logger.debug(`[DoubaoProvider] Generating with model: ${model}`);

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

      const response = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        reasoning_effort: options?.includeReasoning ? reasoningEffort : 'minimal',
      });
      // Extract reasoning_content and content
      const message = response.choices[0]?.message as DoubaoChatCompletionMessage;
      const reasoningContent = message?.reasoning_content || '';
      const content = message?.content || '';

      // Determine whether to include reasoning content in the response
      // Default: false (only include the final answer, not the reasoning process)
      // This prevents users from seeing the internal reasoning process in normal replies
      const includeReasoning = options?.includeReasoning ?? false;

      // Combine reasoning_content and content based on includeReasoning option
      let text = '';

      if (includeReasoning && reasoningContent) {
        // Include reasoning content for internal use (e.g., task analysis)
        text = reasoningContent;
        if (content) {
          text += '\n' + content;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in response | reasoningLength=${reasoningContent.length} | contentLength=${content.length}`,
        );
      } else {
        // Default: only return content (the final answer), not the reasoning process
        // This is the expected behavior for user-facing replies
        text = content;
        if (reasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from response | reasoningLength=${reasoningContent.length} | contentLength=${content.length}`,
          );
        }
      }

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
          reasoningContent: reasoningContent || undefined,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const reasoningEffort = this.config.reasoningEffort || 'medium';

    try {
      logger.debug(`[DoubaoProvider] Generating stream with model: ${model}`);

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

      const streamResult = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
        reasoning_effort: reasoningEffort,
      });

      const stream = streamResult as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

      let fullText = '';
      let fullReasoningContent = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      for await (const chunk of stream) {
        // Handle reasoning_content from delta
        const delta = chunk.choices[0]?.delta as DoubaoChatCompletionDelta;
        const reasoningDelta = delta?.reasoning_content || '';
        if (reasoningDelta) {
          fullReasoningContent += reasoningDelta;
          handler(reasoningDelta);
        }

        // Handle content from delta
        const content = delta?.content || '';
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

      // Determine whether to include reasoning content in the response
      // Default: false (only include the final answer, not the reasoning process)
      const includeReasoning = options?.includeReasoning ?? false;

      // Combine reasoning_content and content based on includeReasoning option
      let finalText = '';
      if (includeReasoning && fullReasoningContent) {
        // Include reasoning content for internal use (e.g., task analysis)
        finalText = fullReasoningContent;
        if (fullText) {
          finalText += '\n' + fullText;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in stream response | reasoningLength=${fullReasoningContent.length} | contentLength=${fullText.length}`,
        );
      } else {
        // Default: only return content (the final answer), not the reasoning process
        finalText = fullText;
        if (fullReasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from stream response | reasoningLength=${fullReasoningContent.length} | contentLength=${fullText.length}`,
          );
        }
      }

      return {
        text: finalText,
        usage,
        metadata: {
          reasoningContent: fullReasoningContent || undefined,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Stream generation failed:', err);
      throw err;
    }
  }

  /**
   * Generate text with vision (multimodal input)
   * Supports Doubao Vision models
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const reasoningEffort = this.config.reasoningEffort || 'medium';

    try {
      logger.debug(`[DoubaoProvider] Generating with vision, model: ${model}`);

      // Build content array with text and images
      const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: prompt },
      ];

      // Add images to content (VisionService normalizes to base64 only; we send data URL to API)
      for (const image of images) {
        let imageUrl: string;
        if (image.base64) {
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.url) {
          imageUrl = image.url;
        } else {
          throw new Error(
            'Invalid image format. Images should be normalized by VisionService (url or base64 required).',
          );
        }

        content.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }

      const createParams = {
        model,
        messages: [
          {
            role: 'user' as const,
            content,
          },
        ],
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        reasoning_effort: reasoningEffort,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParams & { reasoning_effort?: string };
      const response = (await this.client.chat.completions.create(
        createParams,
      )) as OpenAI.Chat.Completions.ChatCompletion;

      // Extract reasoning_content and content
      const message = response.choices[0]?.message as DoubaoChatCompletionMessage;
      const reasoningContent = message?.reasoning_content || '';
      const contentText = message?.content || '';

      // Determine whether to include reasoning content in the response
      // Default: false (only include the final answer, not the reasoning process)
      const includeReasoning = options?.includeReasoning ?? false;

      // Combine reasoning_content and content based on includeReasoning option
      let text = '';
      if (includeReasoning && reasoningContent) {
        // Include reasoning content for internal use (e.g., task analysis)
        text = reasoningContent;
        if (contentText) {
          text += '\n' + contentText;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in vision response | reasoningLength=${reasoningContent.length} | contentLength=${contentText.length}`,
        );
      } else {
        // Default: only return content (the final answer), not the reasoning process
        text = contentText;
        if (reasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from vision response | reasoningLength=${reasoningContent.length} | contentLength=${contentText.length}`,
          );
        }
      }

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
          reasoningContent: reasoningContent || undefined,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Vision generation failed:', err);
      throw err;
    }
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
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const reasoningEffort = this.config.reasoningEffort || 'medium';

    try {
      logger.debug(`[DoubaoProvider] Generating stream with vision, model: ${model}`);

      // Build content array with text and images
      const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: prompt },
      ];

      // Add images to content (VisionService normalizes to base64 only; we send data URL to API)
      for (const image of images) {
        let imageUrl: string;
        if (image.base64) {
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.url) {
          imageUrl = image.url;
        } else {
          throw new Error(
            'Invalid image format. Images should be normalized by VisionService (url or base64 required).',
          );
        }

        content.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }

      const streamResult = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
        reasoning_effort: reasoningEffort,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParams & { reasoning_effort?: string });
      const stream = streamResult as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

      let fullText = '';
      let fullReasoningContent = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      for await (const chunk of stream) {
        // Handle reasoning_content from delta
        const delta = chunk.choices[0]?.delta as DoubaoChatCompletionDelta;
        const reasoningDelta = delta?.reasoning_content || '';
        if (reasoningDelta) {
          fullReasoningContent += reasoningDelta;
          handler(reasoningDelta);
        }

        // Handle content from delta
        const contentDelta = chunk.choices[0]?.delta?.content || '';
        if (contentDelta) {
          fullText += contentDelta;
          handler(contentDelta);
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

      // Determine whether to include reasoning content in the response
      // Default: false (only include the final answer, not the reasoning process)
      const includeReasoning = options?.includeReasoning ?? false;

      // Combine reasoning_content and content based on includeReasoning option
      let finalText = '';
      if (includeReasoning && fullReasoningContent) {
        // Include reasoning content for internal use (e.g., task analysis)
        finalText = fullReasoningContent;
        if (fullText) {
          finalText += '\n' + fullText;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in vision stream response | reasoningLength=${fullReasoningContent.length} | contentLength=${fullText.length}`,
        );
      } else {
        // Default: only return content (the final answer), not the reasoning process
        finalText = fullText;
        if (fullReasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from vision stream response | reasoningLength=${fullReasoningContent.length} | contentLength=${fullText.length}`,
          );
        }
      }

      return {
        text: finalText,
        usage,
        metadata: {
          reasoningContent: fullReasoningContent || undefined,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Vision stream generation failed:', err);
      throw err;
    }
  }
}

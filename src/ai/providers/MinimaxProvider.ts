// Minimax Provider implementation
// Uses MiniMax OpenAI-compatible API at https://api.minimax.io/v1
// Supports MiniMax-M2.7, MiniMax-M2.5, MiniMax-M2.1, MiniMax-M2 models (and highspeed variants).
// Supports vision (image understanding) and tool use.

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type { AIGenerateOptions, AIGenerateResponse, ChatMessage, StreamingHandler } from '../types';

const MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
const MINIMAX_DEFAULT_MODEL = 'MiniMax-M2.7';
const MINIMAX_CHAT_COMPLETIONS_PATH = '/text/chatcompletion_v2';

export interface MinimaxProviderConfig {
  apiKey: string;
  model?: string; // MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5, MiniMax-M2.5-highspeed, MiniMax-M2.1, MiniMax-M2.1-highspeed, MiniMax-M2
  baseURL?: string; // Default: https://api.minimax.io/v1
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
  /** Split reasoning content into a separate field (default: true for reasoning models). */
  reasoningSplit?: boolean;
}

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

type MinimaxContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface MinimaxMessage {
  role: 'system' | 'user' | 'assistant';
  name?: string;
  content: string | MinimaxContentPart[];
}

interface MinimaxTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface MinimaxChatCompletionRequest {
  model: string;
  messages: MinimaxMessage[];
  temperature?: number;
  max_completion_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: MinimaxTool[];
  tool_choice?: string;
  stop?: string[];
  stream_options?: { include_usage?: boolean };
  extra_body?: Record<string, unknown>;
}

interface MinimaxChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    finish_reason?: string;
    index: number;
    message: {
      content: string;
      role: string;
      name?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  created?: number;
  object?: string;
  input_sensitive?: boolean;
  output_sensitive?: boolean;
  base_resp?: { status_code: number; status_msg: string };
}

interface MinimaxStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta?: {
      content?: string;
      reasoning_content?: string;
      role?: string;
    };
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
      role?: string;
    };
  }>;
  usage?: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
  };
  created?: number;
  model?: string;
  object?: string;
}

function isMinimaxStreamChunk(value: unknown): value is MinimaxStreamChunk {
  return typeof value === 'object' && value !== null && 'choices' in value;
}

/**
 * Minimax Provider implementation
 * Implements LLM and Vision capabilities
 * Uses MiniMax OpenAI-compatible API (POST /v1/text/chatcompletion_v2)
 */
export class MinimaxProvider extends AIProvider implements LLMCapability, VisionCapability {
  readonly name = 'minimax';
  override readonly supportsToolUse = true;
  private config: MinimaxProviderConfig;
  private baseUrl: string;
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  constructor(config: MinimaxProviderConfig) {
    super();
    this.config = config;
    this.baseUrl = config.baseURL || MINIMAX_BASE_URL;

    // Explicitly declare supported capabilities
    // Minimax supports both LLM and Vision (image_url in content array)
    this._capabilities = ['llm', 'vision'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    this.httpClient = new HttpClient({
      baseURL: this.baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      defaultTimeout: 120000, // 2 minutes for reasoning models
    });

    if (this.isAvailable()) {
      logger.info('[MinimaxProvider] Initialized');
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
      await this.httpClient.post(
        MINIMAX_CHAT_COMPLETIONS_PATH,
        {
          model: this.config.model || MINIMAX_DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'test' }],
          max_completion_tokens: 1,
        },
        { timeout: 5000 },
      );
      return true;
    } catch (error) {
      logger.debug('[MinimaxProvider] Availability check failed:', error);
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || MINIMAX_DEFAULT_MODEL,
      defaultTemperature: this.config.defaultTemperature ?? 1.0,
      defaultMaxTokens: this.config.defaultMaxTokens ?? 2000,
      reasoningSplit: this.config.reasoningSplit ?? true,
    };
  }

  /**
   * Get capabilities supported by this provider
   * Minimax supports LLM text generation and Vision (multimodal image understanding)
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Minimax client not initialized');
    }

    const model = options?.model ?? this.config.model ?? MINIMAX_DEFAULT_MODEL;
    const temperature = this.sanitizeTemperature(options?.temperature ?? this.config.defaultTemperature ?? 1.0);
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [MinimaxProvider] Generating with model: ${model}`);

      const messages = await this.buildMessages(prompt, options);
      const tools = this.buildTools(options);

      const extraBody: Record<string, unknown> = {};
      if (this.config.reasoningSplit !== false) {
        extraBody.reasoning_split = true;
      }

      const requestBody: MinimaxChatCompletionRequest = {
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        stop: options?.stop,
        extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
      };

      const response = await this.httpClient.post<MinimaxChatCompletionResponse>(
        MINIMAX_CHAT_COMPLETIONS_PATH,
        requestBody,
      );

      return this.parseResponse(response);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MinimaxProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Minimax client not initialized');
    }

    const model = options?.model ?? this.config.model ?? MINIMAX_DEFAULT_MODEL;
    const temperature = this.sanitizeTemperature(options?.temperature ?? this.config.defaultTemperature ?? 1.0);
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [MinimaxProvider] Generating stream with model: ${model}`);

      const messages = await this.buildMessages(prompt, options);

      const extraBody: Record<string, unknown> = {};
      if (this.config.reasoningSplit !== false) {
        extraBody.reasoning_split = true;
      }

      const requestBody: MinimaxChatCompletionRequest = {
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        stop: options?.stop,
        stream: true,
        stream_options: { include_usage: true },
        extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
      };

      const stream = await this.httpClient.stream(MINIMAX_CHAT_COMPLETIONS_PATH, {
        method: 'POST',
        body: requestBody,
      });

      return await this.parseStream(stream, handler, options?.includeReasoning ?? false);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MinimaxProvider] Stream generation failed:', err);
      throw err;
    }
  }

  /**
   * Generate text with vision (multimodal input)
   * Supports MiniMax models via OpenAI-compatible image_url content parts
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Minimax client not initialized');
    }

    const model = options?.model ?? this.config.model ?? MINIMAX_DEFAULT_MODEL;
    const temperature = this.sanitizeTemperature(options?.temperature ?? this.config.defaultTemperature ?? 1.0);
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [MinimaxProvider] Generating with vision, model: ${model}`);

      const content: MinimaxContentPart[] = [{ type: 'text', text: prompt }];

      for (const image of images) {
        let imageUrl: string;
        if (image.base64) {
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.url) {
          imageUrl = image.url;
        } else {
          throw new Error('Invalid image format. Must provide url or base64.');
        }
        content.push({ type: 'image_url', image_url: { url: imageUrl } });
      }

      const messages: MinimaxMessage[] = [];
      if (options?.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content });

      const extraBody: Record<string, unknown> = {};
      if (this.config.reasoningSplit !== false) {
        extraBody.reasoning_split = true;
      }

      const requestBody: MinimaxChatCompletionRequest = {
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        stop: options?.stop,
        extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
      };

      const response = await this.httpClient.post<MinimaxChatCompletionResponse>(
        MINIMAX_CHAT_COMPLETIONS_PATH,
        requestBody,
      );

      return this.parseResponse(response);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MinimaxProvider] Vision generation failed:', err);
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
    if (!this.isAvailable()) {
      throw new Error('Minimax client not initialized');
    }

    const model = options?.model ?? this.config.model ?? MINIMAX_DEFAULT_MODEL;
    const temperature = this.sanitizeTemperature(options?.temperature ?? this.config.defaultTemperature ?? 1.0);
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [MinimaxProvider] Generating stream with vision, model: ${model}`);

      const content: MinimaxContentPart[] = [{ type: 'text', text: prompt }];
      for (const image of images) {
        let imageUrl: string;
        if (image.base64) {
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.url) {
          imageUrl = image.url;
        } else {
          throw new Error('Invalid image format. Must provide url or base64.');
        }
        content.push({ type: 'image_url', image_url: { url: imageUrl } });
      }

      const messages: MinimaxMessage[] = [];
      if (options?.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content });

      const extraBody: Record<string, unknown> = {};
      if (this.config.reasoningSplit !== false) {
        extraBody.reasoning_split = true;
      }

      const requestBody: MinimaxChatCompletionRequest = {
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        stop: options?.stop,
        stream: true,
        stream_options: { include_usage: true },
        extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
      };

      const stream = await this.httpClient.stream(MINIMAX_CHAT_COMPLETIONS_PATH, {
        method: 'POST',
        body: requestBody,
      });

      return await this.parseStream(stream, handler, options?.includeReasoning ?? false);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MinimaxProvider] Vision stream generation failed:', err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * MiniMax temperature range is (0, 1] — 0 is not allowed.
   * Clamp to 0.01 if the caller passed 0.
   */
  private sanitizeTemperature(temperature: number): number {
    if (temperature <= 0) {
      logger.debug('[MinimaxProvider] Temperature must be > 0, clamping to 0.01');
      return 0.01;
    }
    return temperature;
  }

  private async buildMessages(prompt: string, options?: AIGenerateOptions): Promise<MinimaxMessage[]> {
    if (options?.messages?.length) {
      return this.mapChatMessagesToMinimax(options.messages);
    }

    const history = await this.loadHistory(options);
    const messages: MinimaxMessage[] = [];

    for (const msg of history) {
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }

    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  private mapChatMessagesToMinimax(messages: ChatMessage[]): MinimaxMessage[] {
    const mapped: MinimaxMessage[] = [];

    for (const message of messages) {
      if (message.role === 'system') {
        const text = typeof message.content === 'string' ? message.content : '';
        if (text) {
          mapped.push({ role: 'system', content: text });
        }
        continue;
      }

      if (message.role === 'assistant' && message.tool_calls?.length) {
        const assistantText = typeof message.content === 'string' ? message.content : '';
        mapped.push({ role: 'assistant', content: assistantText || '' });
        continue;
      }

      if (message.role === 'tool') {
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
        mapped.push({ role: 'user', content: `[Tool result] ${content}` });
        continue;
      }

      if (typeof message.content === 'string') {
        mapped.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
      } else if (message.content) {
        mapped.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
      } else {
        mapped.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: '' });
      }
    }

    return mapped;
  }

  private buildTools(options?: AIGenerateOptions): MinimaxTool[] {
    if (!options?.tools?.length) {
      return [];
    }
    return options.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private parseResponse(response: MinimaxChatCompletionResponse): AIGenerateResponse {
    if (response.base_resp && response.base_resp.status_code !== 0) {
      throw new Error(`Minimax API error: ${response.base_resp.status_code} ${response.base_resp.status_msg}`);
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error('Minimax response: no choices in response');
    }

    const msg = choice.message;
    const reasoningContent = msg.reasoning_content;
    const text = msg.content ?? '';

    // If includeReasoning is requested and reasoning content exists, prepend it
    const finalText = text;

    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    const result: AIGenerateResponse = {
      text: finalText,
      usage,
      metadata: {
        model: response.model,
        reasoningContent: reasoningContent || undefined,
      },
    };

    if (msg.tool_calls?.length) {
      result.functionCalls = msg.tool_calls.map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
        toolCallId: tc.id,
      }));
    }

    return result;
  }

  private async parseStream(
    stream: ReadableStream<Uint8Array>,
    handler: StreamingHandler,
    includeReasoning: boolean,
  ): Promise<AIGenerateResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let fullReasoningContent = '';
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
            if (!isMinimaxStreamChunk(parsed)) {
              continue;
            }

            const delta = parsed.choices?.[0]?.delta;
            const reasoningDelta = delta?.reasoning_content;
            const contentDelta = delta?.content;

            if (reasoningDelta) {
              fullReasoningContent += reasoningDelta;
              if (includeReasoning) {
                handler(reasoningDelta);
              }
            }

            if (contentDelta) {
              fullText += contentDelta;
              handler(contentDelta);
            }

            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
              };
            }
          } catch (parseError) {
            logger.debug('[MinimaxProvider] Failed to parse stream chunk:', parseError);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const finalText =
      includeReasoning && fullReasoningContent ? fullReasoningContent + (fullText ? `\n${fullText}` : '') : fullText;

    return {
      text: finalText,
      usage,
      metadata: {
        reasoningContent: fullReasoningContent || undefined,
      },
    };
  }
}

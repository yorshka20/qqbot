// Doubao Provider implementation
// Uses Volcengine Ark Responses API: POST /api/v3/responses
// Request: model, input[] with content as input_text / input_image parts.
// See: https://www.volcengine.com/docs/82379/1585135

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type { AIGenerateOptions, AIGenerateResponse, ChatMessage, StreamingHandler } from '../types';

// Responses API: input item content parts (official format)
type ResponsesInputTextPart = { type: 'input_text'; text: string };
type ResponsesInputImagePart = { type: 'input_image'; image_url: string };
type ResponsesInputContentPart = ResponsesInputTextPart | ResponsesInputImagePart;

/** One message in the input array for POST /responses */
interface ResponsesInputItem {
  role: 'user' | 'assistant' | 'system';
  content: ResponsesInputContentPart[];
}

/** Non-stream response from POST /responses (Responses API) */
interface ResponsesApiResponse {
  id?: string;
  model?: string;
  /** Top-level text output (common in Responses API) */
  output_text?: string;
  /** Alternative: output array (e.g. output[].content[].text) */
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/** SSE stream chunk for Responses API (may use output_text or choices.delta) */
interface ResponsesStreamChunk {
  output_text?: string;
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

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
 * Uses Volcengine Ark Responses API (POST /responses) with input[] and input_text/input_image.
 */
export class DoubaoProvider extends AIProvider implements LLMCapability, VisionCapability {
  readonly name = 'doubao';
  private httpClient: HttpClient;
  private config: DoubaoProviderConfig;
  private _capabilities: CapabilityType[];

  constructor(config: DoubaoProviderConfig) {
    super();
    this.config = config;
    const baseURL = config.baseURL || 'https://ark.cn-beijing.volces.com/api/v3';

    // Explicitly declare supported capabilities
    // Doubao supports both LLM and Vision
    this._capabilities = ['llm', 'vision'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    this.httpClient = new HttpClient({
      baseURL,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      defaultTimeout: 120000, // 2 minutes, aligned with other AI providers
    });

    if (this.isAvailable()) {
      logger.info('[DoubaoProvider] Initialized');
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
        '/responses',
        {
          model: this.config.model || 'doubao-seed-1-6-lite-251015',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'test' }] }],
        },
        { timeout: 5000 },
      );
      return true;
    } catch (error) {
      logger.debug('[DoubaoProvider] Availability check failed:', error);
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      return true;
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
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[DoubaoProvider] Generating with model: ${model}`);

      const input = await this.buildResponsesInput(prompt, options);

      const body: Record<string, unknown> = {
        model,
        input,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
      };

      const response = await this.httpClient.post<ResponsesApiResponse>('/responses', body);

      const { text, reasoningContent } = this.extractTextFromResponsesApiResponse(response);
      const includeReasoning = options?.includeReasoning ?? false;

      let finalText = '';
      if (includeReasoning && reasoningContent) {
        finalText = reasoningContent;
        if (text) {
          finalText += `\n${text}`;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in response | reasoningLength=${reasoningContent.length} | contentLength=${text.length}`,
        );
      } else {
        finalText = text;
        if (reasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from response | reasoningLength=${reasoningContent.length} | contentLength=${text.length}`,
          );
        }
      }

      const usage = response.usage
        ? (() => {
            const promptTokens = response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0;
            const completionTokens = response.usage.completion_tokens ?? response.usage.output_tokens ?? 0;
            return {
              promptTokens,
              completionTokens,
              totalTokens: response.usage.total_tokens ?? promptTokens + completionTokens,
            };
          })()
        : undefined;

      return {
        text: finalText,
        usage,
        metadata: {
          model: response.model,
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
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[DoubaoProvider] Generating stream with model: ${model}`);

      const input = await this.buildResponsesInput(prompt, options);

      const body: Record<string, unknown> = {
        model,
        input,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
      };

      const stream = await this.httpClient.stream('/responses', {
        method: 'POST',
        body,
      });

      const result = await this.parseResponsesStream(stream, handler);
      const includeReasoning = options?.includeReasoning ?? false;

      let finalText = '';
      if (includeReasoning && result.fullReasoningContent) {
        finalText = result.fullReasoningContent;
        if (result.fullText) {
          finalText += '\n' + result.fullText;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in stream response | reasoningLength=${result.fullReasoningContent.length} | contentLength=${result.fullText.length}`,
        );
      } else {
        finalText = result.fullText;
        if (result.fullReasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from stream response | reasoningLength=${result.fullReasoningContent.length} | contentLength=${result.fullText.length}`,
          );
        }
      }

      return {
        text: finalText,
        usage: result.usage,
        metadata: {
          reasoningContent: result.fullReasoningContent || undefined,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Stream generation failed:', err);
      throw err;
    }
  }

  /**
   * Build input array for Responses API (input_text / input_image content parts).
   */
  private async buildResponsesInput(prompt: string, options?: AIGenerateOptions): Promise<ResponsesInputItem[]> {
    if (options?.messages?.length) {
      return options.messages.map((m) => this.chatMessageToResponsesInputItem(m));
    }

    const history = await this.loadHistory(options);
    const input: ResponsesInputItem[] = [];
    if (options?.systemPrompt) {
      input.push({
        role: 'system',
        content: [{ type: 'input_text', text: options.systemPrompt }],
      });
    }
    for (const msg of history) {
      input.push({
        role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
        content: [{ type: 'input_text', text: msg.content }],
      });
    }
    input.push({ role: 'user', content: [{ type: 'input_text', text: prompt }] });
    return input;
  }

  /**
   * Convert ChatMessage to Responses API input item (content as input_text / input_image).
   */
  private chatMessageToResponsesInputItem(m: ChatMessage): ResponsesInputItem {
    if (typeof m.content === 'string') {
      return { role: m.role, content: [{ type: 'input_text', text: m.content }] };
    }
    const content: ResponsesInputContentPart[] = m.content.map((part) => {
      if (part.type === 'text') {
        return { type: 'input_text', text: part.text };
      }
      const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url ?? '');
      return { type: 'input_image', image_url: url };
    });
    return { role: m.role, content };
  }

  /**
   * Extract text and optional reasoning from Responses API response body.
   */
  private extractTextFromResponsesApiResponse(response: ResponsesApiResponse): {
    text: string;
    reasoningContent: string;
  } {
    let text = response.output_text ?? '';
    const reasoningContent = '';

    if (response.output?.length) {
      for (const item of response.output) {
        if (item.text) {
          text = text ? `${text}\n${item.text}` : item.text;
        }
        if (item.content?.length) {
          for (const c of item.content) {
            if (c.text) {
              text = text ? `${text}\n${c.text}` : c.text;
            }
          }
        }
      }
    }

    return { text, reasoningContent };
  }

  /**
   * Parse SSE stream from Responses API (supports output_text delta or choices[0].delta).
   */
  private async parseResponsesStream(
    stream: ReadableStream<Uint8Array>,
    handler: StreamingHandler,
  ): Promise<{
    fullText: string;
    fullReasoningContent: string;
    usage: AIGenerateResponse['usage'] | undefined;
  }> {
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

            const data = JSON.parse(jsonStr) as ResponsesStreamChunk;

            // Responses API may send output_text in each chunk
            if (data.output_text) {
              fullText += data.output_text;
              handler(data.output_text);
            }

            // Or OpenAI-style choices[0].delta
            const delta = data.choices?.[0]?.delta;
            if (delta) {
              const reasoningDelta = delta.reasoning_content || '';
              if (reasoningDelta) {
                fullReasoningContent += reasoningDelta;
                handler(reasoningDelta);
              }
              const content = delta.content || '';
              if (content) {
                fullText += content;
                handler(content);
              }
            }

            if (data.usage) {
              const promptTokens = data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0;
              const completionTokens = data.usage.completion_tokens ?? data.usage.output_tokens ?? 0;
              usage = {
                promptTokens,
                completionTokens,
                totalTokens: data.usage.total_tokens ?? promptTokens + completionTokens,
              };
            }
          } catch (parseError) {
            logger.debug('[DoubaoProvider] Failed to parse stream chunk:', parseError);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { fullText, fullReasoningContent, usage };
  }

  /**
   * Generate from full messages (history + current). Content can be string or ContentPart[].
   */
  async generateWithVisionMessages(messages: ChatMessage[], options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    const input: ResponsesInputItem[] = messages.map((m) => this.chatMessageToResponsesInputItem(m));

    const body: Record<string, unknown> = {
      model,
      input,
      temperature,
      max_tokens: maxTokens,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty,
      stop: options?.stop,
    };

    const response = await this.httpClient.post<ResponsesApiResponse>('/responses', body);
    const { text: contentText, reasoningContent } = this.extractTextFromResponsesApiResponse(response);
    const includeReasoning = options?.includeReasoning ?? false;
    const text =
      includeReasoning && reasoningContent
        ? `${reasoningContent}${contentText ? `\n${contentText}` : ''}`
        : contentText;

    const usage = response.usage
      ? (() => {
          const promptTokens = response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0;
          const completionTokens = response.usage.completion_tokens ?? response.usage.output_tokens ?? 0;
          return {
            promptTokens,
            completionTokens,
            totalTokens: response.usage.total_tokens ?? promptTokens + completionTokens,
          };
        })()
      : undefined;

    return {
      text,
      usage,
      metadata: {
        model: response.model,
        reasoningContent: reasoningContent || undefined,
      },
    };
  }

  /**
   * Generate text with vision (multimodal input)
   * Supports Doubao Vision models via Responses API input_text + input_image.
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[DoubaoProvider] Generating with vision, model: ${model}`);

      const userContent = this.buildResponsesVisionContent(prompt, images);
      const input: ResponsesInputItem[] = [];
      if (options?.systemPrompt) {
        input.push({ role: 'system', content: [{ type: 'input_text', text: options.systemPrompt }] });
      }
      input.push({ role: 'user', content: userContent });

      const body: Record<string, unknown> = {
        model,
        input,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
      };

      const response = await this.httpClient.post<ResponsesApiResponse>('/responses', body);
      const { text: contentText, reasoningContent } = this.extractTextFromResponsesApiResponse(response);
      const includeReasoning = options?.includeReasoning ?? false;

      let text = '';
      if (includeReasoning && reasoningContent) {
        text = reasoningContent;
        if (contentText) {
          text += `\n${contentText}`;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in vision response | reasoningLength=${reasoningContent.length} | contentLength=${contentText.length}`,
        );
      } else {
        text = contentText;
        if (reasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from vision response | reasoningLength=${reasoningContent.length} | contentLength=${contentText.length}`,
          );
        }
      }

      const usage = response.usage
        ? (() => {
            const promptTokens = response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0;
            const completionTokens = response.usage.completion_tokens ?? response.usage.output_tokens ?? 0;
            return {
              promptTokens,
              completionTokens,
              totalTokens: response.usage.total_tokens ?? promptTokens + completionTokens,
            };
          })()
        : undefined;

      return {
        text,
        usage,
        metadata: {
          model: response.model,
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
   * Build Responses API content array for vision (input_text + input_image; image_url is string).
   */
  private buildResponsesVisionContent(prompt: string, images: VisionImage[]): ResponsesInputContentPart[] {
    const content: ResponsesInputContentPart[] = [{ type: 'input_text', text: prompt }];

    for (const image of images) {
      let imageUrl: string;
      if (image.base64) {
        const mimeType = image.mimeType || 'image/jpeg';
        imageUrl = `data:${mimeType};base64,${image.base64}`;
      } else if (image.url) {
        imageUrl = image.url;
      } else {
        throw new Error('Invalid image format. Images should be normalized by VisionService (url or base64 required).');
      }
      content.push({ type: 'input_image', image_url: imageUrl });
    }
    return content;
  }

  /**
   * Explain image(s): describe image content as text. Prompt is the full rendered text from the dedicated explain-image template.
   */
  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  /**
   * Generate text with vision and streaming support (Responses API).
   */
  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }

    const model = (this.config.model || 'doubao-seed-1-6-lite-251015') as string;
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.debug(`[DoubaoProvider] Generating stream with vision, model: ${model}`);

      const userContent = this.buildResponsesVisionContent(prompt, images);
      const input: ResponsesInputItem[] = [];
      if (options?.systemPrompt) {
        input.push({ role: 'system', content: [{ type: 'input_text', text: options.systemPrompt }] });
      }
      input.push({ role: 'user', content: userContent });

      const body: Record<string, unknown> = {
        model,
        input,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
      };

      const stream = await this.httpClient.stream('/responses', {
        method: 'POST',
        body,
      });

      const result = await this.parseResponsesStream(stream, handler);
      const includeReasoning = options?.includeReasoning ?? false;

      let finalText = '';
      if (includeReasoning && result.fullReasoningContent) {
        finalText = result.fullReasoningContent;
        if (result.fullText) {
          finalText += `\n${result.fullText}`;
        }
        logger.debug(
          `[DoubaoProvider] Including reasoning content in vision stream response | reasoningLength=${result.fullReasoningContent.length} | contentLength=${result.fullText.length}`,
        );
      } else {
        finalText = result.fullText;
        if (result.fullReasoningContent && !includeReasoning) {
          logger.debug(
            `[DoubaoProvider] Reasoning content present but excluded from vision stream response | reasoningLength=${result.fullReasoningContent.length} | contentLength=${result.fullText.length}`,
          );
        }
      }

      return {
        text: finalText,
        usage: result.usage,
        metadata: {
          reasoningContent: result.fullReasoningContent || undefined,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Vision stream generation failed:', err);
      throw err;
    }
  }
}

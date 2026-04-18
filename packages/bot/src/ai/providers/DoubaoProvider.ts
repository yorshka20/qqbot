// Doubao Provider implementation
// Uses Volcengine Ark Responses API: POST /api/v3/responses
// Request/response shapes follow Ark API; parsing is based on doubao-seed-1-8-251228 response format.
// See: https://www.volcengine.com/docs/82379/1585135

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  ChatMessageRoleBase,
  StreamingHandler,
  ToolDefinition,
} from '../types';

// ---------------------------------------------------------------------------
// Ark Responses API: request types (what we send)
// ---------------------------------------------------------------------------

/** Input content part: text or image (official Ark format). */
type ArkInputTextPart = { type: 'input_text'; text: string };
type ArkInputImagePart = { type: 'input_image'; image_url: string };
type ArkInputContentPart = ArkInputTextPart | ArkInputImagePart;

/** One item in the input array. Role user/system/assistant; content string or parts; no tool_calls/role tool in request (Ark limits). */
interface ArkInputItem {
  role: ChatMessageRoleBase;
  content?: string | ArkInputContentPart[];
}

/** Tool definition in request body: flat shape (Ark does not use nested "function"). */
type ArkToolItem =
  | {
      type: 'function';
      name: string;
      description: string;
      parameters: ToolDefinition['parameters'];
    }
  | {
      type: 'web_search';
    };

/** Request body for POST /api/v3/responses. */
interface ArkResponsesRequest {
  model: string;
  /** Single user text (cache-friendly) or array of input items. */
  input: string | ArkInputItem[];
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
  tools?: ArkToolItem[];
  tool_choice?: string;
  /** Structured output for Responses API: text.format.type = 'json_object' | 'json_schema'. */
  text?: { format: { type: 'json_object' | 'json_schema' } };
}

// ---------------------------------------------------------------------------
// Ark Responses API: response types (doubao-seed-1-8 shape from real responses)
// ---------------------------------------------------------------------------

/** Output item: reasoning (summary text), function_call (name, arguments, call_id), or message (assistant content). */
type ArkOutputItem =
  | {
      type: 'reasoning';
      id?: string;
      summary?: Array<{ type?: string; text?: string }>;
      status?: string;
    }
  | {
      type: 'function_call';
      name: string;
      arguments: string;
      call_id: string;
      id?: string;
      status?: string;
    }
  | {
      type: 'message';
      role: 'assistant';
      content?: Array<{ type?: string; text?: string }>;
      status?: string;
      id?: string;
    };

/** Non-stream response body from POST /responses. */
interface ArkResponsesResponse {
  id?: string;
  model?: string;
  output_text?: string;
  output?: ArkOutputItem[];
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/** Response body from POST /chat/completions (used by lite models that do not support /responses). */
interface ArkChatCompletionsResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Parsed result from Ark response (text, reasoning, usage, optional tool call). */
interface ArkParsedResult {
  text: string;
  reasoningContent: string;
  usage?: AIGenerateResponse['usage'];
  functionCalls?: AIGenerateResponse['functionCalls'];
}

/** SSE stream chunk for Responses API. */
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

/** Default model when config.model is not set (config should set e.g. doubao-seed-1-8-251228). */
const DEFAULT_DOUBAO_MODEL = 'doubao-seed-1-6-lite-251015';

/**
 * Whether this model must use Ark Chat Completions API (POST /chat/completions) instead of Responses API.
 * Lite models (e.g. doubao-1-5-lite-32k-250115) do not have access to the Responses API.
 */
function useChatCompletionsForModel(model: string): boolean {
  return model.toLowerCase().includes('lite');
}

/**
 * Normalize input for request: single user string when possible (cache-friendly), else array.
 * When tools are used or input has multiple/assistant items, always send array.
 */
function normalizeInputForRequest(input: ArkInputItem[], options: { hasTools: boolean }): string | ArkInputItem[] {
  if (options.hasTools) {
    return input;
  }
  if (input.length === 1 && input[0].role === 'user' && typeof input[0].content === 'string') {
    return input[0].content;
  }
  return input;
}

/**
 * Parse Ark Responses API response into a single result (text, reasoning, usage, tool call).
 * Based on doubao-seed-1-8-251228 response shape: output[] with type reasoning | function_call | message.
 */
function parseArkResponse(response: ArkResponsesResponse): ArkParsedResult {
  let text = response.output_text ?? '';
  let reasoningContent = '';

  if (response.output?.length) {
    for (const item of response.output) {
      if (item.type === 'reasoning' && item.summary?.length) {
        for (const s of item.summary) {
          if (s.text) {
            reasoningContent += (reasoningContent ? '\n' : '') + s.text;
          }
        }
      }
      if (item.type === 'message' && item.role === 'assistant' && item.content?.length) {
        for (const c of item.content) {
          const t = (c as { type?: string; text?: string }).text;
          if (t) {
            text = text ? `${text}\n${t}` : t;
          }
        }
      }
    }
  }

  if (!text && response.choices?.[0]?.message?.content) {
    const c = response.choices[0].message.content;
    text = typeof c === 'string' ? c : '';
  }

  const usage = response.usage
    ? {
        promptTokens: response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0,
        completionTokens: response.usage.completion_tokens ?? response.usage.output_tokens ?? 0,
        totalTokens:
          response.usage.total_tokens ??
          (response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0) +
            (response.usage.completion_tokens ?? response.usage.output_tokens ?? 0),
      }
    : undefined;

  let functionCalls: ArkParsedResult['functionCalls'];
  const fnCallItems = response.output?.filter(
    (o): o is Extract<ArkOutputItem, { type: 'function_call' }> => o.type === 'function_call',
  );
  if (fnCallItems?.length) {
    functionCalls = fnCallItems.map((item) => ({
      name: item.name,
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      toolCallId: item.call_id ?? item.id,
    }));
  }

  return { text, reasoningContent, usage, functionCalls };
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
  override readonly supportsToolUse = true;
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
      defaultTimeout: 60000, // 60s for actual request (reasoning models can be slow)
      tlsPreCheck: true, // verify server reachable before sending request
      connectTimeout: 10000, // abort if TLS handshake takes >10s
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
          model: this.config.model ?? DEFAULT_DOUBAO_MODEL,
          input: [{ role: 'user', content: 'test' }],
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
      model: this.config.model ?? DEFAULT_DOUBAO_MODEL,
      defaultTemperature: this.config.defaultTemperature ?? 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens ?? 2000,
      reasoningEffort: this.config.reasoningEffort ?? 'medium',
    };
  }

  /**
   * Get capabilities supported by this provider
   * Doubao supports LLM text generation and Vision (multimodal)
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Lite generation: always uses Ark Chat Completions API (POST /chat/completions).
   * Use for cheap/fast tasks (e.g. prefix-invitation check). Avoids Responses API which lite models do not support.
   */
  async generateLite(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }
    const model = options?.model ?? this.config.model ?? DEFAULT_DOUBAO_MODEL;
    return this.generateViaChatCompletions(prompt, model, options);
  }

  /**
   * Generate using Ark Chat Completions API (POST /chat/completions).
   * Used for lite models that do not have access to the Responses API.
   */
  private async generateViaChatCompletions(
    prompt: string,
    model: string,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options?.temperature ?? this.config.defaultTemperature ?? 0.7,
      max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty,
      stop: options?.stop,
    };
    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    logger.info(`[STATS] [DoubaoProvider] Generating with model (chat/completions): ${model}`);
    const data = await this.httpClient.post<ArkChatCompletionsResponse>('/chat/completions', body);

    const text = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined;

    return {
      text,
      usage,
      metadata: { model },
    };
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }

    const model = options?.model ?? this.config.model ?? DEFAULT_DOUBAO_MODEL;

    // Lite models (e.g. doubao-1-5-lite-32k-250115) do not support Responses API; use Chat Completions API.
    if (useChatCompletionsForModel(model)) {
      return this.generateViaChatCompletions(prompt, model, options);
    }

    try {
      logger.info(`[STATS] [DoubaoProvider] Generating with model: ${model}`);

      const input = await this.buildArkInput(prompt, options);
      const hasTools = !!options?.tools?.length || !!options?.nativeWebSearch;
      const body = this.buildRequestBody(model, input, hasTools, options);

      const response = await this.httpClient.post<ArkResponsesResponse>('/responses', body);
      const parsed = parseArkResponse(response);

      const includeReasoning = options?.includeReasoning ?? false;
      const finalText =
        includeReasoning && parsed.reasoningContent
          ? parsed.reasoningContent + (parsed.text ? `\n${parsed.text}` : '')
          : parsed.text;

      const result: AIGenerateResponse = {
        text: finalText,
        usage: parsed.usage,
        metadata: {
          model: response.model,
          reasoningContent: parsed.reasoningContent || undefined,
        },
        functionCalls: parsed.functionCalls,
      };
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Generation failed:', err);
      throw err;
    }
  }

  /** Build request body for POST /responses from model, input, and options. */
  private buildRequestBody(
    model: string,
    input: ArkInputItem[],
    hasTools: boolean,
    options?: AIGenerateOptions,
  ): ArkResponsesRequest {
    const body: ArkResponsesRequest = {
      model,
      input: normalizeInputForRequest(input, { hasTools }),
      temperature: options?.temperature ?? this.config.defaultTemperature ?? 0.7,
      max_output_tokens: options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty,
      stop: options?.stop,
    };
    if (options?.jsonMode) {
      body.text = { format: { type: 'json_object' } };
    }
    if (hasTools) {
      const tools: ArkToolItem[] = [];
      if (options?.nativeWebSearch) {
        tools.push({ type: 'web_search' });
      }
      if (options?.tools?.length) {
        tools.push(
          ...options.tools.map((t) => ({
            type: 'function' as const,
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        );
      }
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.isAvailable()) {
      throw new Error('Doubao client not initialized');
    }

    const model = options?.model ?? this.config.model ?? DEFAULT_DOUBAO_MODEL;
    try {
      logger.info(`[STATS] [DoubaoProvider] Generating stream with model: ${model}`);

      const input = await this.buildArkInput(prompt, options);
      const body = this.buildRequestBody(model, input, false, options) as ArkResponsesRequest & { stream: boolean };
      body.stream = true;

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
   * Build input array for Ark Responses API.
   * Single-user string is normalized in request for cache; array when tools or multi-turn.
   * Ark does not accept tool_calls on assistant or role "tool"; we drop assistant-with-tool_calls and send tool result as user.
   */
  private async buildArkInput(prompt: string, options?: AIGenerateOptions): Promise<ArkInputItem[]> {
    if (options?.messages?.length) {
      const filtered = options.messages.filter((m) => !(m.role === 'assistant' && m.tool_calls?.length));
      return filtered.map((m) => this.chatMessageToArkInputItem(m));
    }

    const history = await this.loadHistory(options);
    const input: ArkInputItem[] = [];
    if (options?.systemPrompt) {
      input.push({ role: 'system', content: options.systemPrompt });
    }
    for (const msg of history) {
      input.push({
        role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
        content: msg.content,
      });
    }
    input.push({ role: 'user', content: prompt });
    return input;
  }

  /**
   * Convert ChatMessage to Ark input item.
   * Tool messages become user "[Tool result] ..."; assistant with tool_calls is filtered out before this.
   */
  private chatMessageToArkInputItem(m: ChatMessage): ArkInputItem {
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      return { role: 'user', content: `[Tool result] ${content}` };
    }
    if (typeof m.content === 'string') {
      return { role: m.role as ChatMessageRoleBase, content: m.content };
    }
    if (!m.content || !Array.isArray(m.content)) {
      return { role: m.role as ChatMessageRoleBase, content: '' };
    }
    const parts = m.content as Array<{ type?: string; text?: string; image_url?: string | { url?: string } }>;
    const hasImage = parts.some((part) => part.type !== 'text');
    if (!hasImage) {
      const text = parts.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n');
      return { role: m.role as ChatMessageRoleBase, content: text };
    }
    const content: ArkInputContentPart[] = parts.map((part) => {
      if (part.type === 'text') {
        return { type: 'input_text', text: part.text ?? '' };
      }
      const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url ?? '');
      return { type: 'input_image', image_url: url };
    });
    return { role: m.role as ChatMessageRoleBase, content };
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

    const model = options?.model ?? this.config.model ?? DEFAULT_DOUBAO_MODEL;
    const filtered = messages.filter((m) => !(m.role === 'assistant' && m.tool_calls?.length));
    const input: ArkInputItem[] = filtered.map((m) => this.chatMessageToArkInputItem(m));
    const body = this.buildRequestBody(model, input, !!options?.tools?.length, options);

    const response = await this.httpClient.post<ArkResponsesResponse>('/responses', body);
    const parsed = parseArkResponse(response);
    const includeReasoning = options?.includeReasoning ?? false;
    const text =
      includeReasoning && parsed.reasoningContent
        ? parsed.reasoningContent + (parsed.text ? `\n${parsed.text}` : '')
        : parsed.text;

    return {
      text,
      usage: parsed.usage,
      metadata: {
        model: response.model,
        reasoningContent: parsed.reasoningContent || undefined,
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

    const model = options?.model ?? this.config.model ?? DEFAULT_DOUBAO_MODEL;
    try {
      logger.info(`[STATS] [DoubaoProvider] Generating with vision, model: ${model}`);

      const userContent = this.buildVisionContent(prompt, images);
      const input: ArkInputItem[] = [];
      if (options?.systemPrompt) {
        input.push({ role: 'system', content: [{ type: 'input_text', text: options.systemPrompt }] });
      }
      input.push({ role: 'user', content: userContent });

      const body = this.buildRequestBody(model, input, false, options);
      const response = await this.httpClient.post<ArkResponsesResponse>('/responses', body);
      const parsed = parseArkResponse(response);
      const includeReasoning = options?.includeReasoning ?? false;
      const text =
        includeReasoning && parsed.reasoningContent
          ? parsed.reasoningContent + (parsed.text ? `\n${parsed.text}` : '')
          : parsed.text;

      return {
        text,
        usage: parsed.usage,
        metadata: {
          model: response.model,
          reasoningContent: parsed.reasoningContent || undefined,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DoubaoProvider] Vision generation failed:', err);
      throw err;
    }
  }

  /** Build Ark input content array for vision (input_text + input_image). */
  private buildVisionContent(prompt: string, images: VisionImage[]): ArkInputContentPart[] {
    const content: ArkInputContentPart[] = [{ type: 'input_text', text: prompt }];

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

    const model = options?.model ?? this.config.model ?? DEFAULT_DOUBAO_MODEL;
    try {
      logger.info(`[STATS] [DoubaoProvider] Generating stream with vision, model: ${model}`);

      const userContent = this.buildVisionContent(prompt, images);
      const input: ArkInputItem[] = [];
      if (options?.systemPrompt) {
        input.push({ role: 'system', content: [{ type: 'input_text', text: options.systemPrompt }] });
      }
      input.push({ role: 'user', content: userContent });

      const body = this.buildRequestBody(model, input, false, options) as ArkResponsesRequest & { stream: boolean };
      body.stream = true;

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

// DeepSeek-family chat completions: the model contract shared by every host that serves
// DeepSeek models over an OpenAI-compatible /chat/completions endpoint.

import { HttpClient, logger } from '@qqbot/shared';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType, VisionImage } from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  ContentPart,
  StreamingHandler,
  ToolDefinition,
} from '../types';
import { contentToPlainString } from '../utils/contentUtils';
import { visionImageToDataUrl } from '../utils/visionImage';
import { containsDSML, type DSMLFunctionCall, parseDSMLFunctionCall, stripDSML } from './deepseekDsml';
import { clampMaxTokens } from './maxTokens';

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatCompletion {
  choices: Array<{
    finish_reason?: string;
    message: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: ChatCompletionUsage;
  model: string;
}

export interface DeepSeekChatProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

/** What a host fixes about its endpoint; everything else is the model's contract. */
export interface DeepSeekChatHost {
  baseURL: string;
  defaultModel: string;
  capabilities: CapabilityType[];
}

/**
 * DeepSeek models behave the same wherever they are served: reasoning arrives on
 * `reasoning_content` and must be replayed on assistant turns, tool calls sometimes arrive as
 * DSML text, a thinking budget can be spent with no answer, and the reasoning levels are the
 * model's. A host subclass declares only its wire differences — the request parameters it
 * accepts and where its usage reports cache hits.
 */
export abstract class DeepSeekChatProvider extends AIProvider implements LLMCapability, VisionCapability {
  override readonly supportsToolUse = true;
  // mapMessagesToApi puts an assistant turn's reasoning_content on the wire field.
  override readonly echoesReasoningNatively = true;

  /**
   * DeepSeek V4 models take `reasoning_effort` none / low / high / max
   * (https://api-docs.deepseek.com/api/create-chat-completion); `minimal` and `medium` are
   * accepted only as compatibility aliases for low and high, so they are mapped here rather
   * than relying on the aliases — a host may not carry the aliases over.
   */
  protected static readonly REASONING_EFFORT: Record<
    NonNullable<AIGenerateOptions['reasoningEffort']>,
    'none' | 'low' | 'high'
  > = {
    none: 'none',
    minimal: 'low',
    low: 'low',
    medium: 'high',
    high: 'high',
  };

  protected config: DeepSeekChatProviderConfig;
  protected readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly capabilities: CapabilityType[];
  private httpClient: HttpClient;

  constructor(config: DeepSeekChatProviderConfig, host: DeepSeekChatHost) {
    super();
    this.config = config;
    this.baseUrl = config.baseURL || host.baseURL;
    this.defaultModel = host.defaultModel;
    this.capabilities = host.capabilities;

    this.httpClient = new HttpClient({
      baseURL: this.baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      defaultTimeout: 120000, // 2 minutes default timeout for AI processing
    });

    if (this.isAvailable()) {
      logger.info(`${this.logTag} Initialized`);
    }
  }

  /**
   * Put the host's generation parameters on a request body: the output-token cap under the
   * field name it accepts, the sampling parameters it accepts, and the reasoning level.
   */
  protected abstract applyGenerationParams(body: Record<string, unknown>, options: AIGenerateOptions | undefined): void;

  /** Prompt tokens served from the host's cache, read from wherever its usage reports them. */
  protected abstract cachedPromptTokens(usage: ChatCompletionUsage): number | undefined;

  /** The API root this provider calls; a host's batch endpoints live under the same root. */
  get apiBaseURL(): string {
    return this.baseUrl;
  }

  protected get logTag(): string {
    return `[${this.constructor.name}]`;
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
        '/chat/completions',
        this.buildChatCompletionBody('test', { maxTokens: 1, reasoningEffort: 'none' }),
        { timeout: 5000 },
      );
      return true;
    } catch (error) {
      logger.debug(`${this.logTag} Availability check failed:`, error);
      // A timeout means the API is unreachable; any other error (401, 400) means it answered.
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.getDefaultModel(),
      baseURL: this.baseUrl,
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  override getDefaultModel(): string {
    return this.config.model ?? this.defaultModel;
  }

  getCapabilities(): CapabilityType[] {
    return this.capabilities;
  }

  protected resolveMaxTokens(options: AIGenerateOptions | undefined): number {
    return clampMaxTokens(options?.maxTokens ?? this.config.defaultMaxTokens);
  }

  protected resolveReasoningEffort(options: AIGenerateOptions | undefined): 'none' | 'low' | 'high' | undefined {
    return options?.reasoningEffort ? DeepSeekChatProvider.REASONING_EFFORT[options.reasoningEffort] : undefined;
  }

  /**
   * The non-streaming /chat/completions body for a call. Batch submission builds its request
   * lines through this too, so a batched request is exactly the request a live call would send.
   */
  buildChatCompletionBody(prompt: string, options?: AIGenerateOptions): Record<string, unknown> {
    let messages: Array<Record<string, unknown>>;
    if (options?.messages?.length) {
      messages = this.mapMessagesToApi(DeepSeekChatProvider.withSystemPrompt(options.messages, options.systemPrompt));
    } else {
      messages = [];
      if (options?.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });
    }

    const body: Record<string, unknown> = {
      model: options?.model ?? this.getDefaultModel(),
      messages,
      temperature: options?.temperature ?? this.config.defaultTemperature ?? 0.7,
    };
    this.applyGenerationParams(body, options);

    // When jsonMode is set, require valid JSON output (single object; for array output use {"result": [...]} in prompt).
    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    if (options?.tools?.length) {
      body.tools = options.tools.map((t: ToolDefinition) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    return body;
  }

  /** Turn a /chat/completions response — live or out of a batch — into the provider-neutral response. */
  parseChatCompletion(data: ChatCompletion, model: string, options?: AIGenerateOptions): AIGenerateResponse {
    const choice = data.choices[0];
    const msg = choice?.message;
    const rawText = msg?.content ?? '';
    const reasoningContent = msg?.reasoning_content || undefined;

    // A thinking model charges its hidden CoT against max_tokens, so the cap can be
    // spent entirely on reasoning and leave no content. Without this the caller sees
    // an empty string and cannot tell a truncated generation from "nothing to say".
    if (!rawText && !msg?.tool_calls?.length && choice?.finish_reason && choice.finish_reason !== 'stop') {
      throw new Error(`${this.name} returned no content (finish_reason=${choice.finish_reason})`);
    }
    const dsmlCall = !msg?.tool_calls?.length ? this.takeDsmlToolCall(rawText, options) : null;

    const result: AIGenerateResponse = {
      text: stripDSML(rawText),
      usage: data.usage ? this.toUsage(data.usage) : undefined,
      reasoningContent,
      resolvedModel: model,
      metadata: { model: data.model, reasoningContent },
    };

    const toolCalls = msg?.tool_calls;
    if (toolCalls?.length) {
      result.functionCalls = [];
      for (const tc of toolCalls) {
        const fn = tc.function;
        if (fn) {
          result.functionCalls.push({
            name: fn.name ?? '',
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
            toolCallId: tc.id ?? undefined,
          });
        }
      }
    } else if (dsmlCall) {
      result.functionCalls = [{ name: dsmlCall.name, arguments: JSON.stringify(dsmlCall.arguments) }];
    }

    return result;
  }

  private toUsage(usage: ChatCompletionUsage): NonNullable<AIGenerateResponse['usage']> {
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedPromptTokens: this.cachedPromptTokens(usage),
    };
  }

  /**
   * Map ChatMessage[] to the /chat/completions format (supports tool role and assistant tool_calls).
   *
   * When the conversation falls back into this provider mid tool-use (e.g. after Gemini failed in
   * `LLMService.generateWithFallback`), prior `assistant{tool_calls}` turns originate from another
   * provider: their tool_call ids / signatures / reasoning echo-back don't match what DeepSeek
   * expects, so those turns can be rejected. Foreign turns are therefore folded (see
   * `foldForeignToolCalls`); this provider's own turns are replayed verbatim.
   *
   * Every assistant message carries a `reasoning_content` field, empty when there is no
   * reasoning. With tools on, the thinking mode 400s ("The `reasoning_content` in the thinking
   * mode must be passed back to the API") on any assistant message after the last user message
   * that lacks the field — a folded recap included. It checks presence, not content; assistant
   * messages of earlier turns are not checked, so emitting it everywhere is harmless.
   */
  private mapMessagesToApi(messages: ChatMessage[]): Array<Record<string, unknown>> {
    const folded = this.foldForeignToolCalls(messages);
    return folded.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id ?? '',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant',
          content: m.content ?? '',
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
          reasoning_content: m.reasoning_content ?? '',
        };
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: contentToPlainString(m.content),
          reasoning_content: m.reasoning_content ?? '',
        };
      }
      // Image parts survive only on user turns: the API rejects an image in a system or
      // assistant message with a 400 (https://api-docs.deepseek.com/guides/vision).
      if (m.role === 'user' && Array.isArray(m.content)) {
        return { role: 'user', content: m.content };
      }
      return {
        role: m.role,
        content: contentToPlainString(m.content),
      };
    });
  }

  /**
   * True when an `assistant{tool_calls}` turn originates from another provider and must not be
   * replayed verbatim (foreign tool_call ids / missing reasoning echo-back can fail validation).
   * The provenance stamp (`provider`, set by LLMService) is authoritative; turns without a stamp
   * fall back to the missing-reasoning heuristic.
   */
  private isForeignToolCallTurn(m: ChatMessage): boolean {
    if (m.role !== 'assistant' || (m.tool_calls?.length ?? 0) === 0) return false;
    if (m.provider) return m.provider !== this.name;
    return !m.reasoning_content;
  }

  /**
   * Collapse foreign (cross-provider) tool-use turns into assistant-voice recap messages.
   *
   * Each foreign `assistant{tool_calls}` turn plus its consecutive trailing `tool` results
   * becomes one plain `assistant` text message. The role MUST stay assistant and the recap MUST
   * stay first-person: these are the bot's own past actions, and demoting them to a user-voice
   * recap makes the model burn reasoning tokens reconstructing "what did I actually do, in what
   * order". Plain assistant text turns carry no tool_calls, so no provider-specific signature /
   * echo-back validation applies. The foreign turn's reasoning is plain text, so it moves onto
   * the recap unchanged: it is the reasoning behind those calls. This provider's own turns pass
   * through untouched.
   */
  private foldForeignToolCalls(messages: ChatMessage[]): ChatMessage[] {
    if (!messages.some((m) => this.isForeignToolCallTurn(m))) return messages;

    const result: ChatMessage[] = [];
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      if (this.isForeignToolCallTurn(m)) {
        const toolCalls = m.tool_calls ?? [];
        // Index trailing tool results that belong to this assistant turn (consecutive tool messages).
        const resultsByCallId = new Map<string, string>();
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          const tm = messages[j];
          const id = tm.tool_call_id ?? '';
          const text = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content ?? '');
          if (id) resultsByCallId.set(id, text);
          j++;
        }
        const lines: string[] = ['（我在本次回复过程中早些时候执行过以下工具调用，原始记录如下）'];
        const assistantText = contentToPlainString(m.content).trim();
        if (assistantText) {
          lines.push(assistantText);
        }
        for (const tc of toolCalls) {
          const argsText = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
          lines.push(`我调用了 ${tc.name}(${argsText})`);
          const r = resultsByCallId.get(tc.id);
          if (r !== undefined) {
            lines.push(`→ 结果：${r}`);
          }
        }
        result.push({ role: 'assistant', content: lines.join('\n'), reasoning_content: m.reasoning_content });
        i = j;
        continue;
      }
      result.push(m);
      i++;
    }
    return result;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    const body = this.buildChatCompletionBody(prompt, options);
    const model = body.model as string;

    try {
      logger.info(`[STATS] ${this.logTag} Generating with model: ${model}`);
      const data = await this.httpClient.post<ChatCompletion>(
        '/chat/completions',
        body,
        options?.timeout ? { timeout: options.timeout } : undefined,
      );
      return this.parseChatCompletion(data, model, options);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`${this.logTag} Generation failed:`, err);
      throw err;
    }
  }

  /**
   * A tool call DeepSeek wrote as DSML text instead of `tool_calls`. It counts as a call only
   * when the request offered tools; otherwise the markup is just stripped from the text.
   */
  private takeDsmlToolCall(text: string, options?: AIGenerateOptions): DSMLFunctionCall | null {
    if (!containsDSML(text)) {
      return null;
    }
    const call = options?.tools?.length ? parseDSMLFunctionCall(text) : null;
    if (call) {
      logger.debug(`${this.logTag} Parsed DSML text function call: ${call.name}`);
    } else {
      logger.warn(`${this.logTag} Stripping DSML tool-call markup from the response text`);
    }
    return call;
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const { tools: _tools, ...streamOptions } = options ?? {};
    const body = this.buildChatCompletionBody(prompt, streamOptions);
    body.stream = true;
    body.stream_options = { include_usage: true };

    try {
      logger.info(`[STATS] ${this.logTag} Generating stream with model: ${body.model}`);
      const stream = await this.httpClient.stream('/chat/completions', {
        method: 'POST',
        body,
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

              const data = JSON.parse(jsonStr) as {
                choices?: Array<{ delta?: { content?: string } }>;
                usage?: ChatCompletionUsage;
              };

              const content = data.choices?.[0]?.delta?.content || '';
              if (content) {
                fullText += content;
                handler(content);
              }

              if (data.usage) {
                usage = this.toUsage(data.usage);
              }
            } catch (parseError) {
              logger.debug(`${this.logTag} Failed to parse stream chunk:`, parseError);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return {
        text: stripDSML(fullText),
        usage,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`${this.logTag} Stream generation failed:`, err);
      throw err;
    }
  }

  /**
   * Generate from full messages (history + current). Content can be string or ContentPart[].
   */
  async generateWithVisionMessages(messages: ChatMessage[], options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generate('', { ...options, messages });
  }

  /**
   * Generate text with vision (multimodal input).
   * Images ride on the user turn as OpenAI-style image_url parts.
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    return this.generate(prompt, {
      ...options,
      messages: [{ role: 'user', content: DeepSeekChatProvider.buildVisionContent(prompt, images) }],
    });
  }

  /**
   * Generate text with vision and streaming support.
   */
  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    return this.generateStream(prompt, handler, {
      ...options,
      messages: [{ role: 'user', content: DeepSeekChatProvider.buildVisionContent(prompt, images) }],
    });
  }

  /**
   * Explain image(s): describe image content as text. Prompt is the full rendered text from the dedicated explain-image template.
   */
  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  /** Build the user-turn content array for vision (text + image_url parts). */
  private static buildVisionContent(prompt: string, images: VisionImage[]): ContentPart[] {
    const content: ContentPart[] = [{ type: 'text', text: prompt }];
    for (const image of images) {
      content.push({ type: 'image_url', image_url: { url: visionImageToDataUrl(image) } });
    }
    return content;
  }
}

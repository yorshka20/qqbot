// Groq Provider implementation
// Groq offers OpenAI-compatible API with ultra-fast inference

import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { CapabilityType } from '../capabilities/types';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  ChatMessageRole,
  StreamingHandler,
  ToolDefinition,
} from '../types';
import { contentToPlainString } from '../utils/contentUtils';

export interface GroqProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
}

/**
 * Groq Provider implementation
 * Uses OpenAI-compatible API with ultra-fast inference (LPU)
 */
export class GroqProvider extends AIProvider implements LLMCapability {
  readonly name = 'groq';
  override readonly isRelay = true;
  override readonly supportsToolUse = true;
  private config: GroqProviderConfig;
  private baseUrl: string;
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  constructor(config: GroqProviderConfig) {
    super();
    this.config = config;
    this.baseUrl = config.baseURL || 'https://api.groq.com/openai/v1';

    this._capabilities = ['llm', 'function_calling'];

    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    this.httpClient = new HttpClient({
      baseURL: this.baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      defaultTimeout: 60000, // 60s — Groq is fast, shorter timeout is fine
    });

    if (this.isAvailable()) {
      logger.info('[GroqProvider] Initialized');
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
        '/chat/completions',
        {
          model: this.config.model || 'qwen/qwen3-32b',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1,
        },
        { timeout: 5000 },
      );
      return true;
    } catch (error) {
      logger.debug('[GroqProvider] Availability check failed:', error);
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'qwen/qwen3-32b',
      baseURL: this.baseUrl,
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Map ChatMessage[] to OpenAI-compatible API format (supports tool role and assistant tool_calls)
   */
  private mapMessagesToApi(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
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
        };
      }
      return {
        role: m.role,
        content: contentToPlainString(m.content),
      };
    });
  }

  async generateLite(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? 'qwen/qwen3-32b';
    const temperature = options?.temperature ?? 0.1;
    const maxTokens = options?.maxTokens ?? 256;

    const injectOptions: AIGenerateOptions = {
      model,
      temperature,
      maxTokens,
      ...options,
      tools: [],
      reasoningEffort: 'none', // groq can use none.
    };

    return this.generate(prompt, injectOptions);
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? 'qwen/qwen3-32b';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [GroqProvider] Generating with model: ${model}`);

      let messages: Array<Record<string, unknown>>;
      if (options?.messages?.length) {
        messages = this.mapMessagesToApi(options.messages);
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        if (options?.systemPrompt) {
          messages.push({ role: 'system', content: options.systemPrompt });
        }
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
            content: contentToPlainString(msg.content),
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      const body: Record<string, unknown> = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
      };

      applyGroqReasoningParams(body, options);

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

      const data = await this.httpClient.post<{
        choices: Array<{
          message: {
            content?: string;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        model: string;
      }>('/chat/completions', body);

      const msg = data.choices[0]?.message;
      // Strip <think> blocks (closed or unclosed) that thinking models (e.g. Qwen3) may leak
      const rawText = msg?.content ?? '';
      const text = rawText
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')
        .trim();
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined;

      const result: AIGenerateResponse = {
        text,
        usage,
        metadata: { model: data.model },
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
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[GroqProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? 'qwen/qwen3-32b';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [GroqProvider] Generating stream with model: ${model}`);

      let messages: Array<{ role: ChatMessageRole; content: string }>;
      if (options?.messages?.length) {
        messages = options.messages.map((m) => ({ role: m.role, content: contentToPlainString(m.content) }));
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        if (options?.systemPrompt) {
          messages.push({ role: 'system', content: options.systemPrompt });
        }
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
            content: contentToPlainString(msg.content),
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      const streamBody: Record<string, unknown> = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
      };
      applyGroqReasoningParams(streamBody, options);
      if (options?.jsonMode) {
        streamBody.response_format = { type: 'json_object' };
      }
      const stream = await this.httpClient.stream('/chat/completions', {
        method: 'POST',
        body: streamBody,
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      // Belt-and-suspenders `<think>` stripper. Primary defense is
      // `reasoning_format: 'hidden'` (set by applyGroqReasoningParams), which
      // asks Groq to drop reasoning from the content delta stream entirely.
      // This stripper is the fallback for any response that still leaks
      // `<think>…</think>` into content — stateful because the open/close
      // tags often span multiple SSE chunks, so a stateless regex would fail
      // on boundaries.
      const stripper = createThinkStripper();

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
              const jsonStr = line.substring(6);
              if (jsonStr === '[DONE]') {
                continue;
              }

              const data = JSON.parse(jsonStr) as {
                choices?: Array<{ delta?: { content?: string } }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
              };

              const content = data.choices?.[0]?.delta?.content || '';
              if (content) {
                const visible = stripper.push(content);
                if (visible) {
                  fullText += visible;
                  handler(visible);
                }
              }

              if (data.usage) {
                usage = {
                  promptTokens: data.usage.prompt_tokens,
                  completionTokens: data.usage.completion_tokens,
                  totalTokens: data.usage.total_tokens,
                };
              }
            } catch (parseError) {
              logger.debug('[GroqProvider] Failed to parse stream chunk:', parseError);
            }
          }
        }
        // Flush any content trailing the last chunk that was being held back
        // for a potential tag boundary. If the stream ended mid-`<think>`
        // (unclosed), `end()` intentionally drops it.
        const trailing = stripper.end();
        if (trailing) {
          fullText += trailing;
          handler(trailing);
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
      logger.error('[GroqProvider] Stream generation failed:', err);
      throw err;
    }
  }
}

/**
 * Apply Groq reasoning controls to a request body. Called from both the
 * streaming and non-streaming paths — previously the stream path silently
 * dropped `reasoning_effort`, causing thinking-capable models (e.g. Qwen3-32b)
 * to generate hidden `<think>` blocks even when the caller passed
 * `reasoningEffort: 'none'` to cut TTFT.
 *
 * Behavior:
 * - `reasoning_effort`: forwarded verbatim when the caller supplied one.
 *   `'none'` fully disables thinking on providers that support it. No
 *   `reasoning_effort` key is sent when the caller omitted it (preserves
 *   the provider's own default).
 * - `reasoning_format: 'hidden'`: set unconditionally. Groq supports
 *   `raw` (thinking inline as `<think>` XML in content — the default),
 *   `parsed` (separate `reasoning` field), and `hidden` (dropped). We never
 *   surface reasoning content to callers, so `hidden` is strictly cheaper
 *   and prevents the content stream from leaking a `<think>` block that
 *   would otherwise reach downstream consumers (SentenceFlusher → TTS).
 */
function applyGroqReasoningParams(body: Record<string, unknown>, options: AIGenerateOptions | undefined): void {
  if (options?.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }
  // Never surface reasoning content — downstream TTS would otherwise speak
  // the model's internal monologue (user-visible regression on thinking models).
  body.reasoning_format = 'hidden';
}

/**
 * Stateful `<think>…</think>` stripper for Groq SSE streams. Returns only
 * the visible (non-reasoning) portion of each pushed chunk, buffering
 * minimal context across calls so open/close tags split across chunks are
 * detected correctly.
 *
 * Design notes:
 * - While *not* inside a think block, hold back the last 6 chars of the
 *   buffer each emit. That's the max partial prefix of `<think>` (7 chars)
 *   minus 1 — enough to detect a tag that starts in chunk N and completes
 *   in chunk N+1 without ever emitting a partial match.
 * - While *inside* a think block, drop everything except the last 7 chars
 *   (max partial prefix of `</think>`, 8 chars, minus 1).
 * - `end()` emits any held-back content iff we're not mid-think. If the
 *   stream ended with an unclosed `<think>` (rare but possible on error),
 *   we intentionally drop the orphaned reasoning rather than speak it.
 */
export function createThinkStripper(): { push(chunk: string): string; end(): string } {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  // Look-behind window = max-partial-match = tag.length - 1.
  const OPEN_TAIL = OPEN.length - 1;
  const CLOSE_TAIL = CLOSE.length - 1;

  let buf = '';
  let inThink = false;

  return {
    push(chunk: string): string {
      buf += chunk;
      let out = '';
      while (true) {
        if (inThink) {
          const end = buf.indexOf(CLOSE);
          if (end === -1) {
            if (buf.length > CLOSE_TAIL) {
              buf = buf.slice(buf.length - CLOSE_TAIL);
            }
            return out;
          }
          buf = buf.slice(end + CLOSE.length);
          inThink = false;
          continue;
        }
        const start = buf.indexOf(OPEN);
        if (start !== -1) {
          out += buf.slice(0, start);
          buf = buf.slice(start + OPEN.length);
          inThink = true;
          continue;
        }
        // No full open tag — emit everything except the last OPEN_TAIL chars
        // that might be the prefix of a `<think>` continuing in the next chunk.
        const safe = buf.length - OPEN_TAIL;
        if (safe > 0) {
          out += buf.slice(0, safe);
          buf = buf.slice(safe);
        }
        return out;
      }
    },
    end(): string {
      if (inThink) {
        buf = '';
        return '';
      }
      const out = buf;
      buf = '';
      return out;
    },
  };
}

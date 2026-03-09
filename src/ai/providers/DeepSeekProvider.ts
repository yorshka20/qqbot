// DeepSeek Provider implementation

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

/** DeepSeek API max_tokens valid range [1, 8192] */
const DEEPSEEK_MAX_TOKENS_LIMIT = 8192;

export interface DeepSeekProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  /**
   * Enable conversation context (history messages)
   * If true, will use messages from AIGenerateOptions.messages
   */
  enableContext?: boolean;
  /**
   * Number of recent history messages to load automatically
   * Only used when enableContext is true
   */
  contextMessageCount?: number;
}

/**
 * DeepSeek Provider implementation
 * Implements LLM capability for text generation
 */
export class DeepSeekProvider extends AIProvider implements LLMCapability {
  readonly name = 'deepseek';
  private config: DeepSeekProviderConfig;
  private baseUrl: string;
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  constructor(config: DeepSeekProviderConfig) {
    super();
    this.config = config;
    this.baseUrl = config.baseURL || 'https://api.deepseek.com';

    // Explicitly declare supported capabilities
    // DeepSeek currently supports LLM text generation only
    this._capabilities = ['llm'];

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    // Configure HttpClient
    this.httpClient = new HttpClient({
      baseURL: this.baseUrl,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      defaultTimeout: 120000, // 2 minutes default timeout for AI processing
    });

    if (this.isAvailable()) {
      logger.info('[DeepSeekProvider] Initialized');
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
        '/chat/completions',
        {
          model: this.config.model || 'deepseek-chat',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1,
        },
        { timeout: 5000 },
      );
      return true;
    } catch (error) {
      logger.debug('[DeepSeekProvider] Availability check failed:', error);
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
      model: this.config.model || 'deepseek-chat',
      baseURL: this.baseUrl,
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  /**
   * Get capabilities supported by this provider
   * DeepSeek supports LLM text generation
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Map ChatMessage[] to DeepSeek/OpenAI API format (supports tool role and assistant tool_calls)
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
    const model = options?.model ?? this.config.model ?? 'deepseek-chat';
    const temperature = options?.temperature ?? 0.1;
    const maxTokens = options?.maxTokens ?? 256;

    const injectOptions: AIGenerateOptions = {
      model,
      temperature,
      maxTokens,
      ...options,
      tools: [],
      reasoningEffort: 'minimal',
    };

    return this.generate(prompt, injectOptions);
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? 'deepseek-chat';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const rawMaxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const maxTokens = Math.min(Math.max(1, Math.floor(rawMaxTokens)), DEEPSEEK_MAX_TOKENS_LIMIT);

    try {
      logger.debug(`[DeepSeekProvider] Generating with model: ${model}`);

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
      const text = msg?.content ?? '';
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
        const tc = toolCalls[0];
        const fn = tc.function;
        result.functionCall = {
          name: fn?.name ?? '',
          arguments: typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
        };
        result.toolCallId = tc.id ?? undefined;
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DeepSeekProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const model = options?.model ?? this.config.model ?? 'deepseek-chat';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const rawMaxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const maxTokens = Math.min(Math.max(1, Math.floor(rawMaxTokens)), DEEPSEEK_MAX_TOKENS_LIMIT);

    try {
      logger.debug(`[DeepSeekProvider] Generating stream with model: ${model}`);

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

      // Use HttpClient stream method for streaming requests
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
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
              };

              const content = data.choices?.[0]?.delta?.content || '';
              if (content) {
                fullText += content;
                handler(content);
              }

              if (data.usage) {
                usage = {
                  promptTokens: data.usage.prompt_tokens,
                  completionTokens: data.usage.completion_tokens,
                  totalTokens: data.usage.total_tokens,
                };
              }
            } catch (parseError) {
              logger.debug('[DeepSeekProvider] Failed to parse stream chunk:', parseError);
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
      logger.error('[DeepSeekProvider] Stream generation failed:', err);
      throw err;
    }
  }
}

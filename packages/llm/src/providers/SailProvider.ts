// Sail Research: an OpenAI-compatible host serving DeepSeek (and other open) models.

import type { AIGenerateOptions, AIGenerateResponse } from '../types';
import {
  type ChatCompletionUsage,
  DeepSeekChatProvider,
  type DeepSeekChatProviderConfig,
} from './DeepSeekChatProvider';
import { stripDSML } from './deepseekDsml';

export type SailProviderConfig = DeepSeekChatProviderConfig;

/** The subset of a Sail Responses API object a batch result carries. */
export interface SailResponse {
  status: 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'queued' | 'in_progress';
  model: string;
  output: Array<
    | { type: 'message'; content: Array<{ type: string; text?: string }> }
    | { type: 'reasoning'; content?: Array<{ type: string; text?: string }> }
    | { type: string; content?: Array<{ type: string; text?: string }> }
  >;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens: number;
    total_tokens: number;
  };
}

/**
 * Sail's /chat/completions (https://docs.sailresearch.com). Requests run on the `asap` tier,
 * the default when no `service_tier` is sent: the cheaper `balanced` / `flex` tiers queue the
 * first turn for minutes to an hour, and Chat Completions rejects `flex` outright.
 *
 * Batches go through the Responses API instead — the only endpoint Sail batches — and always
 * run on `flex`, so this provider also builds and parses Responses bodies for `SailBatchAdapter`.
 */
export class SailProvider extends DeepSeekChatProvider {
  readonly name = 'sail';
  override readonly isRelay = true;

  constructor(config: SailProviderConfig) {
    super(config, {
      baseURL: 'https://api.sailresearch.com/v1',
      defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      capabilities: ['llm', 'function_calling', 'vision'],
    });
  }

  /**
   * Sail rejects `max_tokens` (it takes `max_completion_tokens`) and does not support `stop`,
   * `frequency_penalty` or `presence_penalty`, so those are never sent.
   */
  protected applyGenerationParams(body: Record<string, unknown>, options: AIGenerateOptions | undefined): void {
    body.max_completion_tokens = this.resolveMaxTokens(options);
    body.top_p = options?.topP;
    const effort = this.resolveReasoningEffort(options);
    if (effort) {
      body.reasoning_effort = effort;
    }
  }

  protected cachedPromptTokens(usage: ChatCompletionUsage): number | undefined {
    return usage.prompt_tokens_details?.cached_tokens;
  }

  /**
   * A single-turn Responses API body: the system prompt as `instructions`, the prompt as
   * `input`. Batch requests carry no history and no tools, so either is refused rather than
   * dropped. Responses does not take `json_object`; an unconstrained object schema is its
   * equivalent.
   */
  buildResponsesBody(prompt: string, options?: AIGenerateOptions): Record<string, unknown> {
    if (options?.messages?.length || options?.tools?.length) {
      throw new Error(`${this.logTag} A Responses batch request is a single prompt; messages and tools are not sent`);
    }
    const body: Record<string, unknown> = {
      model: options?.model ?? this.getDefaultModel(),
      input: prompt,
      max_output_tokens: this.resolveMaxTokens(options),
      temperature: options?.temperature ?? this.config.defaultTemperature ?? 0.7,
      top_p: options?.topP,
    };
    if (options?.systemPrompt) {
      body.instructions = options.systemPrompt;
    }
    const effort = this.resolveReasoningEffort(options);
    if (effort) {
      body.reasoning = { effort };
    }
    if (options?.jsonMode) {
      body.text = { format: { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: false } };
    }
    return body;
  }

  /** Turn a Responses API object into the provider-neutral response, with the same truncation rule as chat. */
  parseResponsesBody(data: SailResponse, model: string): AIGenerateResponse {
    const textOf = (type: string) =>
      data.output
        .filter((item) => item.type === type)
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? '')
        .join('');
    const text = textOf('message');
    const reasoningContent = textOf('reasoning') || undefined;

    if (!text && data.status !== 'completed') {
      const reason = data.incomplete_details?.reason;
      throw new Error(`${this.name} returned no content (status=${data.status}${reason ? `, reason=${reason}` : ''})`);
    }

    return {
      text: stripDSML(text),
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.total_tokens,
            cachedPromptTokens: data.usage.input_tokens_details?.cached_tokens,
          }
        : undefined,
      reasoningContent,
      resolvedModel: model,
      resolvedProviderName: this.name,
      metadata: { model: data.model, reasoningContent },
    };
  }
}

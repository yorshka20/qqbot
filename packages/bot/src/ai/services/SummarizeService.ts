// Summarize Service - single implementation for llm.summarize (thread compression, context memory, etc.)

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { KeepIndicesSchema } from '@/ai/schemas';
import type { LLMService } from '@/ai/services/LLMService';
import { type ExtractStrategy, parseLlmJson } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';

/** cleanThreadTopic prompt expects JSON (keepIndices); usually in code block or raw. */
const CLEAN_THREAD_TOPIC_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'regex'];

export interface SummarizeOptions {
  /** Override LLM provider for this call (e.g. "ollama"). If not set, uses defaultProvider from constructor. */
  provider?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_MAX_TOKENS = 200;

/**
 * Unified summarization: renders llm.summarize prompt and calls LLM.
 * Provider is passed per-call via options.provider when calling summarize().
 */
export class SummarizeService {
  constructor(
    private llmService: LLMService,
    private promptManager: PromptManager,
  ) {}

  /**
   * Summarize conversation text using llm.summarize template.
   * @param conversationText - Formatted conversation (e.g. "User: ...\nAssistant: ...")
   * @param options - Optional provider override and generation params
   * @returns Trimmed summary text, or empty string if LLM returned empty
   */
  async summarize(conversationText: string, options?: SummarizeOptions): Promise<string> {
    const prompt = this.promptManager.render('llm.summarize', { conversationText });
    const provider = options?.provider;

    const response = await this.llmService.generate(
      prompt,
      {
        temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
        maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      provider,
    );

    const text = (response.text ?? '').trim();

    return text;
  }

  /**
   * Ask LLM which message indices to keep for this thread (remove off-topic). Used for periodic thread context cleaning.
   * @returns keepIndices (0-based), or empty array on parse failure / empty response.
   */
  async cleanThreadTopic(
    threadContextWithIndices: string,
    preferenceSummary: string,
    options?: SummarizeOptions,
  ): Promise<number[]> {
    const prompt = this.promptManager.render('llm.thread_clean_topic', {
      threadContextWithIndices,
      preferenceSummary,
    });
    const provider = options?.provider;
    const response = await this.llmService.generate(
      prompt,
      {
        temperature: options?.temperature ?? 0.3,
      },
      provider,
    );
    const text = (response.text ?? '').trim();
    if (!text) {
      return [];
    }
    const result = parseLlmJson(text, KeepIndicesSchema, {
      strategies: CLEAN_THREAD_TOPIC_STRATEGIES,
    });
    if (result == null) {
      logger.debug('[SummarizeService] cleanThreadTopic: no JSON in response or parse failed');
      return [];
    }
    logger.debug(`[SummarizeService] cleanThreadTopic: keep ${result.length} indices`);
    return result;
  }
}

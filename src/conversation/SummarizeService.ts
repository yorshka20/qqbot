// Summarize Service - single implementation for llm.summarize (thread compression, context memory, etc.)

import type { PromptManager } from '@/ai/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { logger } from '@/utils/logger';

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
    if (!text) {
      logger.debug(
        `[SummarizeService] Empty summary from LLM | conversationTextLength=${conversationText.length} provider=${provider ?? 'default'}`,
      );
    }
    return text;
  }
}

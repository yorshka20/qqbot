// Summarize Service - single implementation for llm.summarize (thread compression, context memory, etc.)

import { inject, singleton } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { KeepIndicesSchema } from '@/ai/schemas';
import { LLMService } from '@/ai/services/LLMService';
import { type ExtractStrategy, parseLlmJson } from '@/ai/utils/llmJsonExtract';
import type { Config } from '@/core/config';
import type { LLMTarget } from '@/core/config/types/ai';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';

/** cleanThreadTopic prompt expects JSON (keepIndices); usually in code block or raw. */
const CLEAN_THREAD_TOPIC_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'regex'];

export interface SummarizeOptions {
  temperature?: number;
}

const DEFAULT_TEMPERATURE = 0.5;

/**
 * Unified summarization: renders llm.summarize prompt and calls LLM.
 * Runs on `ai.taskProviders.summarize`, else the default LLM.
 */
@singleton()
export class SummarizeService {
  private readonly target: LLMTarget | undefined;

  constructor(
    @inject(LLMService) private llmService: LLMService,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.CONFIG) config: Config,
  ) {
    const aiConfig = config.getAIConfig();
    this.target = aiConfig?.taskProviders?.summarize ?? aiConfig?.defaultProviders?.llm;
  }

  /**
   * Summarize conversation text using llm.summarize template.
   * @param conversationText - Formatted conversation (e.g. "User: ...\nAssistant: ...")
   * @param options - Optional generation params
   * @returns Trimmed summary text, or empty string if LLM returned empty
   */
  async summarize(conversationText: string, options?: SummarizeOptions): Promise<string> {
    const prompt = this.promptManager.render('llm.summarize', { conversationText });

    const response = await this.llmService.generate(
      prompt,
      {
        temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
        // A summary needs no reasoning, and only 'none' turns it off: at 'low' DeepSeek
        // still thought 5–20K tokens to write a 1–3K-char summary, most of each call's cost.
        reasoningEffort: 'none',
      },
      this.target,
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
    const response = await this.llmService.generate(
      prompt,
      {
        temperature: options?.temperature ?? 0.3,
        jsonMode: true,
        reasoningEffort: 'low',
      },
      this.target,
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

// The one way memory jobs call an LLM: a JSON answer from a background job.

import type { LLMService } from '@/ai/services/LLMService';
import { TOKEN_BUDGET } from '@/ai/tokenBudget';
import { type ExtractStrategy, extractJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';

/**
 * Memory jobs carry a day of chat or a whole memory slot and ask for a document-sized answer.
 * LLMService's 120s default hard-timeout aborts them mid-generation; nothing waits on them,
 * so a longer budget costs nothing.
 */
export const MEMORY_JOB_TIMEOUT_MS = 300_000;

export interface MemoryLLMOptions {
  /** LLM provider name, resolved from config by the caller. */
  provider: string;
  /** Model override; omitted means the provider's configured default. */
  model?: string;
}

const JSON_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'regex'];

/** Parsed JSON object from the model's answer, or null when the call or the parse fails (logged). */
export async function generateMemoryJson(
  llmService: LLMService,
  prompt: string,
  options: MemoryLLMOptions,
  label: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    const res = await llmService.generate(
      prompt,
      {
        temperature: 0.2,
        maxTokens: TOKEN_BUDGET.document,
        model: options.model,
        jsonMode: true,
        timeout: MEMORY_JOB_TIMEOUT_MS,
      },
      options.provider,
    );
    text = (res.text ?? '').trim();
  } catch (err) {
    logger.error(`[${label}] LLM call failed:`, err);
    return null;
  }
  const json = extractJsonFromLlmText(text, { strategies: JSON_STRATEGIES });
  if (json == null) {
    logger.warn(`[${label}] answer is not JSON:`, text.slice(0, 300));
    return null;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    logger.warn(`[${label}] answer JSON does not parse:`, json.slice(0, 300));
    return null;
  }
}

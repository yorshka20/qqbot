// What every memory job sends a model and how its answer is read: one single-turn prompt that
// asks for a JSON object. The jobs run on provider batch APIs (memory/batch), never in realtime.

import type { AIGenerateOptions } from '@qqbot/llm';
import { logger } from '@qqbot/shared';
import { type ExtractStrategy, extractJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import type { MemoryBatchJob } from '@/database/models/types';

/**
 * Per job kind (and the offline legacy migration). Extraction reads a chat log and is allowed
 * more variety; the others decide on stored facts.
 */
export const MEMORY_REQUEST_OPTIONS: Record<MemoryBatchJob['kind'] | 'migrate', AIGenerateOptions> = {
  extract: { temperature: 0.4, reasoningEffort: 'medium', jsonMode: true },
  consolidate: { temperature: 0.2, reasoningEffort: 'medium', jsonMode: true },
  review: { temperature: 0.2, reasoningEffort: 'medium', jsonMode: true },
  migrate: { temperature: 0.2, reasoningEffort: 'medium', jsonMode: true },
};

const JSON_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'regex'];

/** The JSON object in a model's answer, or null when there is none (logged). */
export function parseMemoryJson(text: string, label: string): Record<string, unknown> | null {
  const json = extractJsonFromLlmText(text.trim(), { strategies: JSON_STRATEGIES });
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

/** A memory job's request as submitted. */
export interface MemoryRequest {
  system?: string;
  prompt: string;
  /** The fact ids the prompt's `#n` numbers stand for, `#1` first; empty for extraction. */
  factIds: string[];
  /** The facts the prompt marked due; empty except for review. */
  dueIds: string[];
}

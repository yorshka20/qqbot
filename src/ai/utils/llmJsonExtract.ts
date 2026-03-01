/**
 * Unified extraction of JSON from LLM response text.
 * Handles markdown code blocks, ANSWER: markers, reasoning-prefixed output, and plain JSON.
 * Supports Zod schema for validated, typed result (parseLlmJson(text, schema)).
 */

import type { z } from 'zod';
import { logger } from '@/utils/logger';

export type ExtractStrategy = 'answer' | 'codeBlock' | 'braceMatch' | 'line' | 'regex';

export interface ExtractOptions {
  /** Which strategies to try, in order. Default: all. */
  strategies?: ExtractStrategy[];
  /** Custom marker regex or string (e.g. "ANSWER:") for the answer strategy. */
  marker?: string | RegExp;
}

const DEFAULT_STRATEGIES: ExtractStrategy[] = ['answer', 'codeBlock', 'braceMatch', 'line', 'regex'];

const DEFAULT_ANSWER_MARKER = /ANSWER:\s*([\s\S]*?)(?:\n\n|$)/;
const CODE_BLOCK_REGEX = /```(?:json)?\s*([\s\S]*?)\s*```/;
const GREEDY_JSON_OBJECT_REGEX = /\{[\s\S]*\}/;

/**
 * Try to parse a string as JSON. Returns parsed value or null if invalid.
 */
function tryParseJson(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Strip markdown code block from text if present.
 */
function stripCodeBlock(text: string): string {
  const codeBlockMatch = text.match(CODE_BLOCK_REGEX);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return text;
}

/**
 * Extract a valid JSON string (object or array) from free-form LLM text.
 * Tries configured strategies in order until one returns valid JSON.
 *
 * @param text - Raw LLM response text
 * @param options - Optional strategy list and marker
 * @returns Extracted JSON string or null if none found or invalid
 */
export function extractJsonFromLlmText(text: string, options?: ExtractOptions): string | null {
  const strategies = options?.strategies ?? DEFAULT_STRATEGIES;
  const marker = options?.marker ?? DEFAULT_ANSWER_MARKER;

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  for (const strategy of strategies) {
    let candidate: string | null = null;

    switch (strategy) {
      case 'answer': {
        const markerRegex = typeof marker === 'string' ? new RegExp(`${marker}\\s*([\\s\\S]*?)(?:\\n\\n|$)`) : marker;
        const answerMatch = trimmed.match(markerRegex);
        if (answerMatch) {
          candidate = stripCodeBlock(answerMatch[1].trim());
        }
        break;
      }
      case 'codeBlock': {
        const codeBlockMatch = trimmed.match(CODE_BLOCK_REGEX);
        if (codeBlockMatch) {
          candidate = codeBlockMatch[1].trim();
        }
        break;
      }
      case 'braceMatch': {
        const lastBrace = trimmed.lastIndexOf('}');
        if (lastBrace === -1) {
          break;
        }
        let braceCount = 0;
        let startIndex = -1;
        for (let i = lastBrace; i >= 0; i--) {
          const char = trimmed[i];
          if (char === '}') {
            braceCount++;
          } else if (char === '{') {
            braceCount--;
            if (braceCount === 0) {
              startIndex = i;
              break;
            }
          }
        }
        if (startIndex !== -1) {
          candidate = trimmed.substring(startIndex, lastBrace + 1);
        }
        break;
      }
      case 'line': {
        const lines = trimmed.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith('{') && line.endsWith('}')) {
            candidate = line;
            break;
          }
        }
        break;
      }
      case 'regex': {
        const match = trimmed.match(GREEDY_JSON_OBJECT_REGEX);
        if (match) {
          candidate = match[0];
        }
        break;
      }
    }

    if (candidate != null && candidate.length > 0) {
      const parsed = tryParseJson(candidate);
      if (parsed !== null && typeof parsed === 'object') {
        logger.debug(`[llmJsonExtract] Extracted valid JSON using strategy: ${strategy}`);
        return candidate;
      }
    }
  }

  logger.debug(`[llmJsonExtract] No valid JSON found after trying ${strategies.length} strategies`);
  return null;
}

/**
 * Extract JSON from LLM text and validate/transform with a Zod schema.
 * Result type is inferred from the schema. Returns null if extraction or validation fails.
 * Only schema-based parsing is supported; use a schema to define and constrain the result type.
 */
export function parseLlmJson<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options?: ExtractOptions,
): T | null {
  const extracted = extractJsonFromLlmText(text, options);
  if (extracted == null) {
    return null;
  }
  const parsed = tryParseJson(extracted);
  if (parsed === null) {
    return null;
  }
  const result = schema.safeParse(parsed);
  if (result.success) {
    return result.data as T;
  }
  return null;
}

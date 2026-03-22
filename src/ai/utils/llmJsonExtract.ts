/**
 * Unified extraction of JSON from LLM response text.
 * Handles markdown code blocks, ANSWER: markers, reasoning-prefixed output, and plain JSON.
 * Supports Zod schema for validated, typed result (parseLlmJson(text, schema)).
 *
 * **Separation of concerns:**
 * - Content **expected to be JSON** (e.g. card deck, structured LLM output): use
 *   `extractExpectedJsonFromLlmText` or `parseExpectedJsonFromLlmText` only. Do not mix with non-JSON strategies.
 * - Content **expected not to be JSON** (e.g. search query plain text like SEARCH:/MULTI_SEARCH:): parse as
 *   plain text only; do not use the JSON-specific extractors.
 */

import type { z } from 'zod';
import { type SearchDecisionResult, SearchDecisionSchema } from '@/ai/schemas';
import { logger } from '@/utils/logger';

/**
 * Parse LLM response that is plain "true" or "false" (case-insensitive).
 * Uses first non-empty line (or full trimmed text). Reusable for boolean yes/no prompts (e.g. prefix-invitation).
 * @returns true, false, or null if unrecognized (caller may treat null as fail-closed).
 */
export function parseLlmTrueFalse(text: string): boolean | null {
  // Strip <think>...</think> blocks from thinking models (e.g. Qwen3)
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const line = stripped.split(/\r?\n/)[0]?.trim() ?? stripped;
  const lower = line.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  return null;
}

/**
 * Parse MULTI_SEARCH text format into individual queries.
 * Format: "查询1: <query> | <explanation>\n查询2: <query> | <explanation>"
 */
function parseMultiSearchQueries(content: string): Array<{ query: string; explanation: string }> {
  const queries: Array<{ query: string; explanation: string }> = [];
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);

  for (const line of lines) {
    const match = line.match(/^查询\d+:\s*(.+?)\s*\|\s*(.+)$/);
    if (match) {
      const [, query, explanation] = match;
      queries.push({
        query: query.trim(),
        explanation: explanation.trim(),
      });
    } else {
      queries.push({
        query: line,
        explanation: 'Auto-extracted search query',
      });
    }
  }
  return queries;
}

/**
 * Parse search decision from LLM response.
 * When response might be JSON, uses dedicated JSON parser only (parseExpectedJsonFromLlmText).
 * Otherwise parses plain text: NO_SEARCH, SEARCH: <query>, MULTI_SEARCH:\n查询1: ... | ...
 */
export function parseSearchDecision(response: string): SearchDecisionResult {
  const trimmed = response.trim();

  const fromJson = parseExpectedJsonFromLlmText(trimmed, SearchDecisionSchema);
  if (fromJson !== null) {
    return fromJson;
  }

  const upperTrimmed = trimmed.toUpperCase();

  if (upperTrimmed.startsWith('MULTI_SEARCH:')) {
    const multiSearchContent = trimmed.substring(13).trim();
    const queries = parseMultiSearchQueries(multiSearchContent);
    return {
      needsSearch: queries.length > 0,
      queries,
      isMultiSearch: true,
    };
  }

  if (upperTrimmed.startsWith('SEARCH:')) {
    const query = trimmed.substring(7).trim();
    return {
      needsSearch: query.length > 0,
      query: query || undefined,
      isMultiSearch: false,
    };
  }

  return {
    needsSearch: false,
    isMultiSearch: false,
  };
}

export type ExtractStrategy = 'answer' | 'codeBlock' | 'braceMatch' | 'line' | 'regex';

export interface ExtractOptions {
  /** Which strategies to try, in order. Default: all. */
  strategies?: ExtractStrategy[];
  /** Custom marker regex or string (e.g. "ANSWER:") for the answer strategy. */
  marker?: string | RegExp;
}

const DEFAULT_STRATEGIES: ExtractStrategy[] = ['answer', 'codeBlock', 'braceMatch', 'line', 'regex'];

/** Use only when LLM output is expected to be JSON (e.g. card deck). Do not use for plain-text (e.g. search query). */
export const JSON_ONLY_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'braceMatch', 'regex'];

const DEFAULT_ANSWER_MARKER = /ANSWER:\s*([\s\S]*?)(?:\n\n|$)/;
const CODE_BLOCK_REGEX = /```(?:json)?\s*([\s\S]*?)\s*```/;
const GREEDY_JSON_OBJECT_REGEX = /\{[\s\S]*\}/;
const GREEDY_JSON_ARRAY_REGEX = /\[[\s\S]*\]/;

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
 * Parse JSON text and ensure the result is a single object (not a top-level array).
 * Some providers (e.g. response_format.json_object) only guarantee a JSON object; if the model
 * returns an array (e.g. [{}]), wrap it as { result: array } so downstream can use obj.result.
 *
 * @param text - JSON string (e.g. LLM response when jsonMode was true)
 * @returns { value, wrapped } where value is the parsed object; wrapped is true if original was array
 */
export function ensureJsonObject(text: string): { value: Record<string, unknown>; wrapped: boolean } | null {
  const parsed = tryParseJson(text.trim());
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  if (Array.isArray(parsed)) {
    return { value: { result: parsed }, wrapped: true };
  }
  return { value: parsed as Record<string, unknown>, wrapped: false };
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
 * Extract a balanced JSON array substring [...] from text (find last ']', then matching '[').
 * Returns null if no balanced array found.
 */
function extractBalancedJsonArray(text: string): string | null {
  const lastBracket = text.lastIndexOf(']');
  if (lastBracket === -1) {
    return null;
  }
  let bracketCount = 0;
  let startIndex = -1;
  for (let i = lastBracket; i >= 0; i--) {
    const char = text[i];
    if (char === ']') {
      bracketCount++;
    } else if (char === '[') {
      bracketCount--;
      if (bracketCount === 0) {
        startIndex = i;
        break;
      }
    }
  }
  if (startIndex !== -1) {
    return text.substring(startIndex, lastBracket + 1);
  }
  return null;
}

/**
 * Extract a balanced JSON object substring {...} from text (find last '}', then matching '{').
 * Returns null if no balanced object found.
 */
function extractBalancedJsonObject(text: string): string | null {
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace === -1) {
    return null;
  }
  let braceCount = 0;
  let startIndex = -1;
  for (let i = lastBrace; i >= 0; i--) {
    const char = text[i];
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
    return text.substring(startIndex, lastBrace + 1);
  }
  return null;
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
        // Try both array and object; prefer the outermost (longer) valid JSON so "[{...}]" yields array, "{\"tasks\": [...]}" yields object
        const arrayCandidate = extractBalancedJsonArray(trimmed);
        const objectCandidate = extractBalancedJsonObject(trimmed);
        const arrayValid = arrayCandidate != null && tryParseJson(arrayCandidate) !== null;
        const objectValid = objectCandidate != null && tryParseJson(objectCandidate) !== null;
        if (arrayValid && objectValid && arrayCandidate != null && objectCandidate != null) {
          candidate = arrayCandidate.length >= objectCandidate.length ? arrayCandidate : objectCandidate;
        } else if (arrayValid) {
          candidate = arrayCandidate;
        } else if (objectValid) {
          candidate = objectCandidate;
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
        // Try both array and object; prefer the longer valid JSON (outermost)
        const arrayMatch = trimmed.match(GREEDY_JSON_ARRAY_REGEX);
        const objectMatch = trimmed.match(GREEDY_JSON_OBJECT_REGEX);
        const arrayStr = arrayMatch != null && tryParseJson(arrayMatch[0]) !== null ? arrayMatch[0] : null;
        const objectStr = objectMatch != null && tryParseJson(objectMatch[0]) !== null ? objectMatch[0] : null;
        if (arrayStr != null && objectStr != null) {
          candidate = arrayStr.length >= objectStr.length ? arrayStr : objectStr;
        } else if (arrayStr != null) {
          candidate = arrayStr;
        } else if (objectStr != null) {
          candidate = objectStr;
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

/**
 * Extract JSON from LLM text when the content is **expected to be JSON** (e.g. card deck, structured output).
 * Uses only JSON-suited strategies (codeBlock, braceMatch, regex); does not use answer/line or other
 * non-JSON strategies. Supports both JSON objects and arrays (e.g. card deck [{...}]).
 *
 * Do not use for content that is expected to be plain text (e.g. search query SEARCH:/MULTI_SEARCH:).
 *
 * @param text - Raw LLM response text
 * @param options - Optional strategy list (default: JSON_ONLY_STRATEGIES)
 * @returns Extracted JSON string or null if none found or invalid
 */
export function extractExpectedJsonFromLlmText(text: string, options?: ExtractOptions): string | null {
  const strategies = options?.strategies ?? JSON_ONLY_STRATEGIES;
  return extractJsonFromLlmText(text, { ...options, strategies });
}

/**
 * Extract and parse JSON from LLM text when the content is **expected to be JSON**, with Zod schema validation.
 * Use only for expected-JSON responses. Do not use for plain-text (e.g. search query).
 *
 * @param text - Raw LLM response text
 * @param schema - Zod schema for validation
 * @param options - Optional strategy list (default: JSON_ONLY_STRATEGIES)
 * @returns Parsed and validated value, or null
 */
export function parseExpectedJsonFromLlmText<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options?: ExtractOptions,
): T | null {
  const extracted = extractExpectedJsonFromLlmText(text, options);
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

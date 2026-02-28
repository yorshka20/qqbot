// Shared filter & refine step for search results: LLM judges relevance and either returns refined reference text (DONE) or requests more queries (MORE).

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { SearchResult } from '@/retrieval';
import { logger } from '@/utils/logger';

export type FilterRefineResult = { done: true; refinedText: string } | { done: false; queries: string[] };

/**
 * Build full result text for the filter-refine prompt (title + full snippet per result). No truncation.
 */
export function buildSearchResultSummaries(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const title = (r.title || '无标题').trim();
      const snippet = (r.snippet || r.content || '').trim();
      return `${i + 1}. ${title}${snippet ? `\n   ${snippet}` : ''}`;
    })
    .join('\n\n');
}

/**
 * Build full chunk text for the filter-refine prompt (e.g. proactive flow chunks). No truncation.
 */
export function buildSummariesFromChunks(chunks: string[]): string {
  return chunks
    .map((c, i) => {
      const oneLine = c.replace(/\n/g, ' ').trim();
      return `${i + 1}. ${oneLine}`;
    })
    .join('\n');
}

/**
 * Parse LLM output from the filter-refine prompt.
 * Expects either "DONE\n\n<refined text>" or "MORE:\n<query1> | <query2>".
 */
export function parseFilterRefineResponse(responseText: string): FilterRefineResult | null {
  const trimmed = responseText.trim();
  const upper = trimmed.toUpperCase();

  if (upper.startsWith('DONE')) {
    const afterDone = trimmed.slice(4).trimStart();
    // Remove leading newlines so refined text can start on next line
    const refinedText = afterDone.replace(/^\n+/, '').trim();
    return { done: true, refinedText: refinedText || '' };
  }

  if (upper.startsWith('MORE:') || upper.startsWith('MORE：')) {
    const afterMore = trimmed.slice(5).trim();
    const queries = afterMore
      .split(/[\n|]/)
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
    return { done: false, queries };
  }

  return null;
}

export interface FilterAndRefineOptions {
  /** Topic or user question (used as context for relevance). */
  topic: string;
  /** Pre-formatted result summaries (from buildSearchResultSummaries or buildSummariesFromChunks). */
  resultSummaries: string;
  /** Current round (1-based). */
  round: number;
  /** Max rounds (so LLM prefers DONE on last round). */
  maxRounds: number;
}

/**
 * Call the filter-refine LLM once. Returns refined reference text (DONE) or list of supplement queries (MORE).
 * On parse failure or LLM error, returns { done: true, refinedText: resultSummaries } so the pipeline can continue with unfiltered content.
 */
export async function filterAndRefineSearchResults(
  llmService: LLMService,
  promptManager: PromptManager,
  options: FilterAndRefineOptions,
): Promise<FilterRefineResult> {
  const { topic, resultSummaries, round, maxRounds } = options;

  const prompt = promptManager.render('llm.search_results_filter_refine', {
    topic,
    resultSummaries: resultSummaries || '(无)',
    round: String(round),
    maxRounds: String(maxRounds),
  });

  let responseText: string;
  try {
    const response = await llmService.generate(prompt, {
      temperature: 0.2,
      maxTokens: 2000,
    });
    responseText = (response.text || '').trim();
  } catch (err) {
    logger.warn(`[searchResultsFilterRefine] LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    return { done: true, refinedText: resultSummaries };
  }

  const parsed = parseFilterRefineResponse(responseText);
  if (parsed) {
    return parsed;
  }

  logger.warn('[SearchFilterRefine] Could not parse DONE/MORE from response, using summaries as refined text');
  return { done: true, refinedText: resultSummaries };
}

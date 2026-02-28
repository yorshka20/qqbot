// Filter-refine types and helpers for search results (used by SearchService / RetrievalService)

export type FilterRefineResult = { done: true; refinedText: string } | { done: false; queries: string[] };

export interface FilterAndRefineOptions {
  /** Topic or user question (used as context for relevance). */
  topic: string;
  /** Pre-formatted result summaries for the filter-refine prompt (e.g. from buildSummariesFromStringChunks). */
  resultSummaries: string;
  /** Current round (1-based). */
  round: number;
  /** Max rounds (so LLM prefers DONE on last round). */
  maxRounds: number;
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

/**
 * Build numbered summaries from string chunks (e.g. proactive flow).
 */
export function buildSummariesFromStringChunks(chunks: string[]): string {
  return chunks
    .map((c, i) => {
      const oneLine = c.replace(/\n/g, ' ').trim();
      return `${i + 1}. ${oneLine}`;
    })
    .join('\n');
}

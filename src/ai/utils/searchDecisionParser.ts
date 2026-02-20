/**
 * Shared parser for LLM search decision output.
 * Supports NO_SEARCH, SEARCH: <query>, MULTI_SEARCH format.
 * Used by ReplyGenerationService and SearXNGPreferenceKnowledgeService.
 */

export interface SearchDecisionResult {
  needsSearch: boolean;
  query?: string;
  queries?: Array<{ query: string; explanation: string }>;
  isMultiSearch?: boolean;
}

/**
 * Parse search decision from LLM response.
 * Supports NO_SEARCH, SEARCH: <query>, MULTI_SEARCH format.
 */
export function parseSearchDecision(response: string): SearchDecisionResult {
  const trimmed = response.trim();
  const upperTrimmed = trimmed.toUpperCase();

  // Check if response starts with "MULTI_SEARCH:"
  if (upperTrimmed.startsWith('MULTI_SEARCH:')) {
    const multiSearchContent = trimmed.substring(13).trim();
    const queries = parseMultiSearchQueries(multiSearchContent);

    return {
      needsSearch: queries.length > 0,
      queries,
      isMultiSearch: true,
    };
  }

  // Check if response starts with "SEARCH:"
  if (upperTrimmed.startsWith('SEARCH:')) {
    const query = trimmed.substring(7).trim();
    return {
      needsSearch: query.length > 0,
      query: query || undefined,
      isMultiSearch: false,
    };
  }

  // No search needed (handles "NO_SEARCH" or any other response)
  return {
    needsSearch: false,
    isMultiSearch: false,
  };
}

/**
 * Parse MULTI_SEARCH format into individual queries.
 * Format: "查询1: <query> | <explanation>\n查询2: <query> | <explanation>"
 */
export function parseMultiSearchQueries(
  content: string,
): Array<{ query: string; explanation: string }> {
  const queries: Array<{ query: string; explanation: string }> = [];
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);

  for (const line of lines) {
    // Match format like "查询1: search term | explanation" (Chinese format from prompt)
    const match = line.match(/^查询\d+:\s*(.+?)\s*\|\s*(.+)$/);
    if (match) {
      const [, query, explanation] = match;
      queries.push({
        query: query.trim(),
        explanation: explanation.trim(),
      });
    } else {
      // Fallback: treat entire line as query if format doesn't match
      queries.push({
        query: line,
        explanation: 'Auto-extracted search query',
      });
    }
  }

  return queries;
}

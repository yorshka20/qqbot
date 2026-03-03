/**
 * Zod schema for LLM search decision JSON output.
 * Used by parseSearchDecision in @/ai/utils/llmJsonExtract (JSON path);
 * plain text fallback (NO_SEARCH / SEARCH: / MULTI_SEARCH) remains in llmJsonExtract.
 */

import { z } from 'zod';

const searchDecisionQueryItemSchema = z.object({
  query: z.string(),
  explanation: z.string(),
});

export const SearchDecisionSchema = z.object({
  needsSearch: z.boolean(),
  query: z.string().optional(),
  queries: z.array(searchDecisionQueryItemSchema).optional(),
  isMultiSearch: z.boolean().optional(),
});

export type SearchDecisionResult = z.infer<typeof SearchDecisionSchema>;

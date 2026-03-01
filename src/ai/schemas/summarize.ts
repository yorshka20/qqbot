/**
 * Zod schema for LLM summarize / thread clean topic JSON output.
 * Used by SummarizeService.cleanThreadTopic.
 */

import { z } from 'zod';

export const KeepIndicesSchema = z
  .object({
    keepIndices: z
      .unknown()
      .optional()
      .transform((v): number[] => {
        if (!Array.isArray(v)) {
          return [];
        }
        return v
          .map((x) => (typeof x === 'number' ? x : typeof x === 'string' ? parseInt(x, 10) : Number.NaN))
          .filter((n) => !Number.isNaN(n) && n >= 0);
      }),
  })
  .transform((o) => o.keepIndices ?? []);

/**
 * Zod schema for LLM preliminary analysis JSON output.
 * Used by PreliminaryAnalysisService.
 */

import { z } from 'zod';

export const PreliminaryAnalysisSchema = z.object({
  shouldJoin: z.unknown().transform((v): boolean => v === true),
  reason: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
  topic: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
  replyInThreadId: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
  createNew: z
    .unknown()
    .optional()
    .transform((v): true | undefined => (v === true ? true : undefined)),
  threadShouldEndId: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
  messageIds: z
    .unknown()
    .optional()
    .transform((v): string[] | undefined => {
      if (!Array.isArray(v)) {
        return undefined;
      }
      const out = v
        .map((x) => (typeof x === 'number' ? String(x) : typeof x === 'string' ? x : null))
        .filter((x): x is string => x != null && x.length > 0);
      return out.length ? out : undefined;
    }),
  preferenceKey: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
  searchQueries: z
    .unknown()
    .optional()
    .transform((v): string[] | undefined => {
      if (!Array.isArray(v)) {
        return undefined;
      }
      const out = v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
      return out.length ? out : undefined;
    }),
});

export type PreliminaryAnalysisResult = z.infer<typeof PreliminaryAnalysisSchema>;

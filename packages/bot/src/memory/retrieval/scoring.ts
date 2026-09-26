// Reranking of searched facts: similarity weighted by recency and confirmations.

import type { MemoryScoringConfig } from '@/core/config/types/memory';
import type { MemoryFact } from '@/database/models/types';

export const DEFAULT_SCORING: Required<MemoryScoringConfig> = {
  transientHalfLifeDays: 30,
  decayFloor: 0.5,
  confirmBoostPerConfirm: 0.03,
  confirmBoostCap: 1.3,
};

const DAY_MS = 86_400_000;

/**
 * Relevance of a searched fact: similarity, weighted by how recently a transient fact was last
 * confirmed and by how often it has been confirmed. Stable facts do not decay.
 */
export function scoreFact(
  similarity: number,
  fact: Pick<MemoryFact, 'durability' | 'lastConfirmedAt' | 'confirmCount'>,
  scoring: Required<MemoryScoringConfig>,
  now: number,
): number {
  const ageDays = Math.max(0, (now - fact.lastConfirmedAt) / DAY_MS);
  const recency =
    fact.durability === 'transient' ? Math.max(scoring.decayFloor, 2 ** (-ageDays / scoring.transientHalfLifeDays)) : 1;
  const confirmation = Math.min(
    scoring.confirmBoostCap,
    1 + Math.max(0, fact.confirmCount - 1) * scoring.confirmBoostPerConfirm,
  );
  return similarity * recency * confirmation;
}

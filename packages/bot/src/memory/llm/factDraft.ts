// A new fact as a model writes it (consolidation, review merges, migration), checked before storage.

import type { MemoryFact } from '@/database/models/types';
import { isAllowedScope } from '../model/scopes';

export interface NewFactDraft {
  scope: string;
  content: string;
  durability: MemoryFact['durability'];
}

/** Prompts ask for at most 50 characters; this leaves room before rejecting outright. */
const MAX_FACT_LENGTH = 120;

/**
 * A draft fact from model output, or null when it cannot be stored as is. A missing or unknown
 * durability reads as transient: such a fact decays and comes up for review instead of lingering.
 */
export function parseDraft(raw: Record<string, unknown>, userId: string): NewFactDraft | null {
  const scope = typeof raw.scope === 'string' ? raw.scope.trim().toLowerCase() : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content || content.length > MAX_FACT_LENGTH || !isAllowedScope(userId, scope)) {
    return null;
  }
  return { scope, content, durability: raw.durability === 'stable' ? 'stable' : 'transient' };
}

/** The fact at a 1-based `#n` the model named, or null when out of range or already claimed. */
export function factAtNumber(numbered: MemoryFact[], value: unknown, claimed: Set<string>): MemoryFact | null {
  const index = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  const fact = Number.isInteger(index) ? numbered[index - 1] : undefined;
  return fact && !claimed.has(fact.id) ? fact : null;
}

// Review rules: when a fact is due, how the model sees the slot, and which decisions stand.

import type { MemoryReviewConfig } from '@/core/config/types/memory';
import type { MemoryFact } from '@/database/models/types';
import { factAtNumber, type NewFactDraft, parseDraft } from '../llm/factDraft';

const DAY_MS = 86_400_000;

export type ReviewDecision =
  | { op: 'keep'; id: string; durability?: MemoryFact['durability'] }
  | { op: 'retire'; id: string; reason: string }
  | { op: 'merge'; ids: string[]; fact: NewFactDraft };

export function isDue(
  fact: Pick<MemoryFact, 'durability' | 'lastConfirmedAt' | 'reviewedAt'>,
  review: Required<MemoryReviewConfig>,
  now: number,
): boolean {
  const lastTouched = Math.max(fact.lastConfirmedAt, fact.reviewedAt ?? 0);
  const days = fact.durability === 'transient' ? review.transientAfterDays : review.stableAfterDays;
  return now - lastTouched >= days * DAY_MS;
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function numberFactsForReview(facts: MemoryFact[], due: Set<string>): string {
  return facts
    .map(
      (fact, i) =>
        `${due.has(fact.id) ? '待复审 ' : ''}#${i + 1} [${fact.scope}] (${fact.durability}) ${fact.content}` +
        ` ｜ ${formatDate(fact.firstSeen)} ｜ ${formatDate(fact.lastConfirmedAt)} ｜ ${fact.confirmCount} ｜ ${fact.hitCount}`,
    )
    .join('\n');
}

/**
 * Validate review decisions. keep/retire must name a due fact; merge may name any listed fact
 * but must include at least one due fact. Each fact is named by at most one decision.
 */
export function parseReviewDecisions(
  answer: Record<string, unknown>,
  numbered: MemoryFact[],
  due: Set<string>,
  userId: string,
): { decisions: ReviewDecision[]; rejected: number } {
  const raw = Array.isArray(answer.decisions) ? answer.decisions : [];
  const claimed = new Set<string>();
  const factAt = (value: unknown) => factAtNumber(numbered, value, claimed);
  const decisions: ReviewDecision[] = [];
  let rejected = 0;
  for (const item of raw) {
    const d = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (d.op === 'keep' || d.op === 'retire') {
      const target = factAt(d.id);
      if (target && due.has(target.id)) {
        claimed.add(target.id);
        if (d.op === 'keep') {
          const durability = d.durability === 'stable' || d.durability === 'transient' ? d.durability : undefined;
          decisions.push({ op: 'keep', id: target.id, durability });
        } else {
          decisions.push({ op: 'retire', id: target.id, reason: typeof d.reason === 'string' ? d.reason : '临时信息' });
        }
        continue;
      }
    } else if (d.op === 'merge') {
      const fact = parseDraft(d, userId);
      const targets = (Array.isArray(d.ids) ? d.ids : []).map(factAt);
      const valid = targets.length >= 2 && targets.every((t): t is MemoryFact => t !== null);
      if (fact && valid && targets.some((t) => t !== null && due.has(t.id))) {
        const ids = [...new Set((targets as MemoryFact[]).map((t) => t.id))];
        for (const id of ids) {
          claimed.add(id);
        }
        decisions.push({ op: 'merge', ids, fact });
        continue;
      }
    }
    rejected++;
  }
  return { decisions, rejected };
}

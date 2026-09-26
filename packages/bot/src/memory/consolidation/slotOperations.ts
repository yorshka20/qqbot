// The operations a consolidation answer may apply to a slot, validated against its numbered facts.

import type { MemoryFact } from '@/database/models/types';
import { factAtNumber, type NewFactDraft, parseDraft } from '../llm/factDraft';

export type SlotOperation =
  | { op: 'add'; fact: NewFactDraft }
  | { op: 'confirm'; id: string }
  | { op: 'update'; ids: string[]; fact: NewFactDraft }
  | { op: 'delete'; id: string; reason: string };

/**
 * Validate the model's operations against the numbered facts. Each existing fact is named by
 * at most one operation; later operations naming it again are rejected.
 */
export function parseSlotOperations(
  answer: Record<string, unknown>,
  numbered: MemoryFact[],
  userId: string,
): { operations: SlotOperation[]; rejected: number } {
  const raw = Array.isArray(answer.operations) ? answer.operations : [];
  const claimed = new Set<string>();
  const operations: SlotOperation[] = [];
  let rejected = 0;
  for (const item of raw) {
    const op = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (op.op === 'add') {
      const fact = parseDraft(op, userId);
      if (fact) {
        operations.push({ op: 'add', fact });
        continue;
      }
    } else if (op.op === 'confirm' || op.op === 'delete') {
      const target = factAtNumber(numbered, op.id, claimed);
      if (target) {
        claimed.add(target.id);
        operations.push(
          op.op === 'confirm'
            ? { op: 'confirm', id: target.id }
            : { op: 'delete', id: target.id, reason: typeof op.reason === 'string' ? op.reason : '被新信息推翻' },
        );
        continue;
      }
    } else if (op.op === 'update') {
      const fact = parseDraft(op, userId);
      const targets = (Array.isArray(op.ids) ? op.ids : [op.id]).map((id) => factAtNumber(numbered, id, claimed));
      if (fact && targets.length > 0 && targets.every((t): t is MemoryFact => t !== null)) {
        const ids = [...new Set(targets.map((t) => t.id))];
        for (const id of ids) {
          claimed.add(id);
        }
        operations.push({ op: 'update', ids, fact });
        continue;
      }
    }
    rejected++;
  }
  return { operations, rejected };
}

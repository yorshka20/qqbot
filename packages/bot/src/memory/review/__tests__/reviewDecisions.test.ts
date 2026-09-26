import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { MemoryFact } from '@/database/models/types';
import { isDue, parseReviewDecisions } from '../reviewDecisions';

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
const REVIEW = { transientAfterDays: 30, stableAfterDays: 180 };
const USER = '10000001';

function fact(id: string, durability: MemoryFact['durability'], lastConfirmedDaysAgo: number): MemoryFact {
  return {
    id,
    groupId: '100000001',
    userId: USER,
    scope: 'behavior',
    content: `事实 ${id}`,
    durability,
    status: 'active',
    firstSeen: NOW - 400 * DAY,
    lastConfirmedAt: NOW - lastConfirmedDaysAgo * DAY,
    confirmCount: 1,
    hitCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('isDue', () => {
  it('uses the durability threshold since the last confirmation', () => {
    expect(isDue(fact('a', 'transient', 31), REVIEW, NOW)).toBe(true);
    expect(isDue(fact('b', 'transient', 10), REVIEW, NOW)).toBe(false);
    expect(isDue(fact('c', 'stable', 100), REVIEW, NOW)).toBe(false);
    expect(isDue(fact('d', 'stable', 200), REVIEW, NOW)).toBe(true);
  });

  it('counts a review as touching the fact', () => {
    expect(isDue({ ...fact('a', 'transient', 60), reviewedAt: NOW - 5 * DAY }, REVIEW, NOW)).toBe(false);
  });
});

describe('parseReviewDecisions', () => {
  const facts = [fact('a', 'transient', 60), fact('b', 'transient', 60), fact('c', 'stable', 1)];
  const due = new Set(['a', 'b']);

  it('accepts keep/retire on due facts and merges that include one', () => {
    const { decisions, rejected } = parseReviewDecisions(
      {
        decisions: [
          { op: 'retire', id: 1, reason: '已过去的计划' },
          { op: 'merge', ids: [2, 3], scope: 'behavior', durability: 'stable', content: '合并后的习惯' },
        ],
      },
      facts,
      due,
      USER,
    );
    expect(rejected).toBe(0);
    expect(decisions).toEqual([
      { op: 'retire', id: 'a', reason: '已过去的计划' },
      { op: 'merge', ids: ['b', 'c'], fact: { scope: 'behavior', durability: 'stable', content: '合并后的习惯' } },
    ]);
  });

  it('rejects keep/retire on facts that are not due, and merges of one fact', () => {
    const { decisions, rejected } = parseReviewDecisions(
      {
        decisions: [
          { op: 'retire', id: 3, reason: '……' },
          { op: 'merge', ids: [1], scope: 'behavior', content: '……' },
          { op: 'keep', id: 2, durability: 'stable' },
        ],
      },
      facts,
      due,
      USER,
    );
    expect(decisions).toEqual([{ op: 'keep', id: 'b', durability: 'stable' }]);
    expect(rejected).toBe(2);
  });
});

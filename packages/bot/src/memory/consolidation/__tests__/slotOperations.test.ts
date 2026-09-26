import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { MemoryFact } from '@/database/models/types';
import { parseDraft } from '../../llm/factDraft';
import { numberFacts } from '../../llm/promptParts';
import { GROUP_MEMORY_USER_ID } from '../../model/constants';
import { parseSlotOperations } from '../slotOperations';

const USER = '10000001';

function fact(id: string, scope: string, content: string): MemoryFact {
  return {
    id,
    groupId: '100000001',
    userId: USER,
    scope,
    content,
    durability: 'stable',
    status: 'active',
    firstSeen: 1,
    lastConfirmedAt: 1,
    confirmCount: 1,
    hitCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const existing = [
  fact('a', 'identity:work', '在县城做运营商相关工作'),
  fact('b', 'identity:work', '从事精益生产相关工作'),
  fact('c', 'preference:game', '喜欢玩战双'),
];

describe('numberFacts', () => {
  it('numbers facts from 1 with scope and durability', () => {
    expect(numberFacts(existing.slice(0, 1))).toBe('#1 [identity:work] (stable) 在县城做运营商相关工作');
    expect(numberFacts([])).toBe('（无）');
  });
});

describe('parseDraft', () => {
  it('rejects scopes the slot may not hold', () => {
    expect(parseDraft({ scope: 'rule', content: '不刷屏' }, USER)).toBeNull();
    expect(parseDraft({ scope: 'rule', content: '不刷屏', durability: 'stable' }, GROUP_MEMORY_USER_ID)).toEqual({
      scope: 'rule',
      content: '不刷屏',
      durability: 'stable',
    });
  });

  it('reads a missing durability as transient', () => {
    expect(parseDraft({ scope: 'preference', content: '最近在玩某游戏' }, USER)?.durability).toBe('transient');
  });
});

describe('parseSlotOperations', () => {
  it('maps numbered ids back to fact ids', () => {
    const { operations, rejected } = parseSlotOperations(
      {
        operations: [
          { op: 'update', ids: [1, 2], scope: 'identity:work', durability: 'stable', content: '在县城从事运营商工作' },
          { op: 'confirm', id: 3 },
          { op: 'add', scope: 'preference:food', durability: 'stable', content: '不吃辣' },
        ],
      },
      existing,
      USER,
    );
    expect(rejected).toBe(0);
    expect(operations).toEqual([
      {
        op: 'update',
        ids: ['a', 'b'],
        fact: { scope: 'identity:work', durability: 'stable', content: '在县城从事运营商工作' },
      },
      { op: 'confirm', id: 'c' },
      { op: 'add', fact: { scope: 'preference:food', durability: 'stable', content: '不吃辣' } },
    ]);
  });

  it('lets each fact be named by one operation only', () => {
    const { operations, rejected } = parseSlotOperations(
      {
        operations: [
          { op: 'confirm', id: 1 },
          { op: 'delete', id: 1, reason: '被推翻' },
        ],
      },
      existing,
      USER,
    );
    expect(operations).toEqual([{ op: 'confirm', id: 'a' }]);
    expect(rejected).toBe(1);
  });

  it('rejects out-of-range ids, unknown ops and disallowed scopes', () => {
    const { operations, rejected } = parseSlotOperations(
      {
        operations: [
          { op: 'confirm', id: 9 },
          { op: 'rewrite', id: 1 },
          { op: 'add', scope: 'rule', content: '群规' },
          { op: 'update', ids: [1, 7], scope: 'identity', content: '……' },
        ],
      },
      existing,
      USER,
    );
    expect(operations).toEqual([]);
    expect(rejected).toBe(4);
  });
});

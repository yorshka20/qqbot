import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { GROUP_MEMORY_USER_ID } from '@/memory/MemoryService';
import { memorySubjectKey, type FactMeta } from '@/memory/MemoryFactMetaService';
import { assembleMemoryBrowse } from '../memoryBrowse';

function fact(partial: Pick<FactMeta, 'groupId' | 'userId' | 'scope' | 'normalizedContent'> & Partial<FactMeta>): FactMeta {
  return {
    factHash: partial.factHash ?? `${partial.groupId}-${partial.userId}-${partial.scope}`,
    source: partial.source ?? 'llm_extract',
    status: partial.status ?? 'active',
    firstSeen: partial.firstSeen ?? 1,
    lastReinforced: partial.lastReinforced ?? 1,
    reinforceCount: partial.reinforceCount ?? 1,
    hitCount: partial.hitCount ?? 0,
    ...partial,
  };
}

describe('assembleMemoryBrowse', () => {
  it('nests group memory ahead of people and attaches display names', () => {
    const tree = assembleMemoryBrowse(
      [
        fact({
          groupId: '100',
          userId: '200',
          scope: 'preference:food',
          normalizedContent: '喜欢吃辣',
          lastReinforced: 10,
        }),
        fact({
          groupId: '100',
          userId: GROUP_MEMORY_USER_ID,
          scope: 'rule',
          normalizedContent: '不要刷屏',
          source: 'manual',
          lastReinforced: 20,
        }),
      ],
      new Map([['100', '测试群']]),
      new Map([[memorySubjectKey('100', '200'), '测试用户甲']]),
      86_400_000,
    );

    expect(tree.stats.totalFacts).toBe(2);
    expect(tree.stats.manualFacts).toBe(1);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0]?.groupName).toBe('测试群');
    expect(tree.groups[0]?.users.map((user) => user.userId)).toEqual([GROUP_MEMORY_USER_ID, '200']);
    expect(tree.groups[0]?.users[0]?.isGroupMemory).toBe(true);
    expect(tree.groups[0]?.users[0]?.nickname).toBeUndefined();
    expect(tree.groups[0]?.users[1]?.nickname).toBe('测试用户甲');
    expect(tree.groups[0]?.users[1]?.facts[0]?.scope).toBe('preference:food');
    expect(tree.groups[0]?.users[1]?.facts[0]?.content).toBe('喜欢吃辣');
  });
});
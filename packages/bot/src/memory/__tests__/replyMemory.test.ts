import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@/core/config';
import type { MemoryFact } from '@/database/models/types';
import type { MemoryFactStore } from '../MemoryFactStore';
import type { MemoryIndex, MemorySearchHit, MemorySearchOptions } from '../MemoryIndex';
import { MemoryService, renderSlot, scoreFact } from '../MemoryService';
import { GROUP_MEMORY_USER_ID } from '../memoryConstants';

const GROUP = '100000001';
const USER = '10000001';
const DAY = 86_400_000;
const SCORING = { transientHalfLifeDays: 30, decayFloor: 0.5, confirmBoostPerConfirm: 0.03, confirmBoostCap: 1.3 };

function fact(id: string, userId: string, scope: string, content: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    groupId: GROUP,
    userId,
    scope,
    content,
    durability: 'stable',
    status: 'active',
    firstSeen: 1,
    lastConfirmedAt: Date.now(),
    confirmCount: 1,
    hitCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}

describe('scoreFact', () => {
  const now = 100 * DAY;

  it('does not decay stable facts', () => {
    expect(scoreFact(0.6, { durability: 'stable', lastConfirmedAt: 0, confirmCount: 1 }, SCORING, now)).toBeCloseTo(0.6);
  });

  it('halves a transient fact per half-life, down to the floor', () => {
    const at = (days: number) => now - days * DAY;
    expect(
      scoreFact(0.6, { durability: 'transient', lastConfirmedAt: at(15), confirmCount: 1 }, SCORING, now),
    ).toBeCloseTo(0.6 * 2 ** -0.5);
    expect(
      scoreFact(0.6, { durability: 'transient', lastConfirmedAt: at(300), confirmCount: 1 }, SCORING, now),
    ).toBeCloseTo(0.3);
  });

  it('adds weight per confirmation, capped', () => {
    expect(scoreFact(0.5, { durability: 'stable', lastConfirmedAt: now, confirmCount: 3 }, SCORING, now)).toBeCloseTo(
      0.53,
    );
    expect(scoreFact(0.5, { durability: 'stable', lastConfirmedAt: now, confirmCount: 50 }, SCORING, now)).toBeCloseTo(
      0.65,
    );
  });
});

describe('renderSlot', () => {
  it('puts manual facts first under their own heading, then automatic facts by scope order', () => {
    const text = renderSlot(
      [{ scope: 'instruction', content: '不要用 emoji' }],
      [
        { scope: 'context', content: '群原本是技术群' },
        { scope: 'identity:work', content: '做运营商工作' },
      ],
    );
    expect(text).toBe(
      [
        '【人工维护，与其他条目冲突时以此为准】',
        '[instruction]',
        '- 不要用 emoji',
        '',
        '【自动整理】',
        '[identity:work]',
        '- 做运营商工作',
        '',
        '[context]',
        '- 群原本是技术群',
      ].join('\n'),
    );
  });

  it('has no headings when there is no manual memory', () => {
    expect(renderSlot([], [{ scope: 'rule', content: '不刷屏' }])).toBe('[rule]\n- 不刷屏');
  });
});

describe('MemoryService.getMemoryForReply', () => {
  let dir: string;
  const facts = [
    fact('g-rule', GROUP_MEMORY_USER_ID, 'rule:bot', '回复里不要用 emoji'),
    fact('g-topic', GROUP_MEMORY_USER_ID, 'topic:games', '群里常聊二次元游戏'),
    fact('u-inst', USER, 'instruction', '回答前先核实'),
    fact('u-game', USER, 'preference:game', '长期玩战双'),
    fact('u-food', USER, 'preference:food', '不吃辣'),
  ];
  const hitsRecorded: string[][] = [];
  const searches: MemorySearchOptions[] = [];

  const store = {
    listSlot: async (_g: string, userId: string) => facts.filter((f) => f.userId === userId),
    recordHits: async (ids: string[]) => {
      hitsRecorded.push(ids);
    },
  } as unknown as MemoryFactStore;

  function service(searchEnabled: boolean, hits: MemorySearchHit[]): MemoryService {
    const index = {
      isEnabled: () => searchEnabled,
      search: async (_g: string, _q: string, options: MemorySearchOptions) => {
        searches.push(options);
        return hits;
      },
    } as unknown as MemoryIndex;
    const config = { getMemoryConfig: () => ({ dir }) } as unknown as Config;
    return new MemoryService(config, store, index);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    hitsRecorded.length = 0;
    searches.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries manual memory, always-include scopes and the searched facts that clear the threshold', async () => {
    const memory = service(true, [
      { id: 'u-game', score: 0.66 },
      { id: 'g-topic', score: 0.6 },
      { id: 'u-food', score: 0.3 },
    ]);
    await memory.saveManualMemory(GROUP, USER, '[instruction]\n称呼我为甲');

    const result = await memory.getMemoryForReply(GROUP, USER, '你还记得我玩什么游戏吗');

    expect(result.groupMemoryText).toBe('[topic:games]\n- 群里常聊二次元游戏\n\n[rule:bot]\n- 回复里不要用 emoji');
    expect(result.userMemoryText).toContain('【人工维护，与其他条目冲突时以此为准】\n[instruction]\n- 称呼我为甲');
    expect(result.userMemoryText).toContain('[preference:game]\n- 长期玩战双');
    expect(result.userMemoryText).toContain('[instruction]\n- 回答前先核实');
    expect(result.userMemoryText).not.toContain('不吃辣');
    expect(searches[0].owners).toEqual({ userId: USER, includeGroup: true });
    expect(searches[0].excludeCoreScopes).toEqual(['instruction', 'rule']);
    await Promise.resolve();
    expect(hitsRecorded).toEqual([['u-game', 'g-topic']]);
  });

  it('carries every fact when there is no vector index', async () => {
    const result = await service(false, []).getMemoryForReply(GROUP, USER, '随便什么');
    expect(result.userMemoryText).toContain('不吃辣');
    expect(result.groupMemoryText).toContain('群里常聊二次元游戏');
    expect(hitsRecorded).toEqual([]);
  });
});

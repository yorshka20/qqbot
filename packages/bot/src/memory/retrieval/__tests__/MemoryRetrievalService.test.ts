import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@/core/config';
import type { MemoryFact } from '@/database/models/types';
import { GROUP_MEMORY_USER_ID } from '../../model/constants';
import { ManualMemoryStore } from '../../storage/ManualMemoryStore';
import type { MemoryFactStore } from '../../storage/MemoryFactStore';
import type { MemoryIndex, MemorySearchHit, MemorySearchOptions } from '../../storage/MemoryIndex';
import { MemoryRetrievalService } from '../MemoryRetrievalService';

const GROUP = '100000001';
const USER = '10000001';

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

describe('MemoryRetrievalService.getMemoryForReply', () => {
  let dir: string;
  let manual: ManualMemoryStore;
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

  function service(searchEnabled: boolean, hits: MemorySearchHit[]): MemoryRetrievalService {
    const index = {
      isEnabled: () => searchEnabled,
      search: async (_g: string, _q: string, options: MemorySearchOptions) => {
        searches.push(options);
        return hits;
      },
    } as unknown as MemoryIndex;
    const config = { getMemoryConfig: () => ({ dir }) } as unknown as Config;
    manual = new ManualMemoryStore(config);
    return new MemoryRetrievalService(config, store, index, manual);
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
    await manual.save(GROUP, USER, '[instruction]\n称呼我为甲');

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

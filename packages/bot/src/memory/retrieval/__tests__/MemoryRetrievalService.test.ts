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
  let hits: MemorySearchHit[] = [];

  const store = {
    listSlot: async (_g: string, userId: string) => facts.filter((f) => f.userId === userId),
    listGroup: async () => facts,
    recordHits: async (ids: string[]) => {
      hitsRecorded.push(ids);
    },
  } as unknown as MemoryFactStore;

  function service(searchEnabled: boolean): MemoryRetrievalService {
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

  function manualId(userId: string, content: string): string {
    const found = manual.getFacts(GROUP, userId).find((f) => f.content === content);
    if (!found) {
      throw new Error(`no manual fact ${content}`);
    }
    return found.id;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    hitsRecorded.length = 0;
    searches.length = 0;
    hits = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries always-include scopes and the searched facts that clear the threshold, manual and automatic alike', async () => {
    const memory = service(true);
    await manual.save(GROUP, USER, '[instruction]\n称呼我为甲\n\n[identity:work]\n做前端开发\n\n[preference:food]\n爱吃甜食');
    await manual.save(GROUP, GROUP_MEMORY_USER_ID, '[context]\n本群是测试群');
    hits = [
      { id: 'u-game', score: 0.66 },
      { id: manualId(USER, '做前端开发'), score: 0.62 },
      { id: 'g-topic', score: 0.6 },
      { id: 'u-food', score: 0.3 },
      { id: manualId(USER, '爱吃甜食'), score: 0.3 },
    ];

    const result = await memory.getMemoryForReply(GROUP, USER, '你还记得我做什么工作吗');

    expect(result.groupMemoryText).toBe('[topic:games]\n- 群里常聊二次元游戏\n\n[rule:bot]\n- 回复里不要用 emoji');
    expect(result.userMemoryText).toStartWith(
      '【人工维护，与其他条目冲突时以此为准】\n[identity:work]\n- 做前端开发\n\n[instruction]\n- 称呼我为甲\n\n【自动整理】',
    );
    expect(result.userMemoryText).toContain('[preference:game]\n- 长期玩战双');
    expect(result.userMemoryText).toContain('[instruction]\n- 回答前先核实');
    expect(result.userMemoryText).not.toContain('不吃辣');
    expect(result.userMemoryText).not.toContain('爱吃甜食');
    expect(searches[0].owners).toEqual({ userId: USER, includeGroup: true });
    expect(searches[0].excludeCoreScopes).toEqual(['instruction', 'rule']);
    await Promise.resolve();
    expect(hitsRecorded).toEqual([['u-game', 'g-topic']]);
  });

  it('ranks a manual fact as fully confirmed', async () => {
    const memory = service(true);
    await manual.save(GROUP, USER, '[identity:work]\n做前端开发');
    hits = [
      { id: manualId(USER, '做前端开发'), score: 0.4 },
      { id: 'u-game', score: 0.4 },
    ];

    const result = await memory.getMemoryForReply(GROUP, USER, '你做什么的');

    expect(result.userMemoryText).toContain('做前端开发');
    expect(result.userMemoryText).not.toContain('长期玩战双');
  });

  it('carries every fact when there is no vector index', async () => {
    const memory = service(false);
    await manual.save(GROUP, USER, '[preference:food]\n爱吃甜食');
    const result = await memory.getMemoryForReply(GROUP, USER, '随便什么');
    expect(result.userMemoryText).toContain('不吃辣');
    expect(result.userMemoryText).toContain('爱吃甜食');
    expect(result.groupMemoryText).toContain('群里常聊二次元游戏');
    expect(hitsRecorded).toEqual([]);
  });
});

describe('MemoryRetrievalService.searchMemory', () => {
  let dir: string;
  let manual: ManualMemoryStore;
  const facts = [
    fact('u-game', USER, 'preference:game', '长期玩战双'),
    fact('g-topic', GROUP_MEMORY_USER_ID, 'topic:games', '群里常聊二次元游戏'),
  ];
  let hits: MemorySearchHit[] = [];

  function service(searchEnabled: boolean): MemoryRetrievalService {
    const store = { listGroup: async () => facts } as unknown as MemoryFactStore;
    const index = { isEnabled: () => searchEnabled, search: async () => hits } as unknown as MemoryIndex;
    const config = { getMemoryConfig: () => ({ dir }) } as unknown as Config;
    manual = new ManualMemoryStore(config);
    return new MemoryRetrievalService(config, store, index, manual);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    hits = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ranks manual and automatic facts together and marks the manual ones', async () => {
    const memory = service(true);
    await manual.save(GROUP, USER, '[preference:game]\n最近在玩星穹铁道\n\n[identity:work]\n做前端开发');
    const [game, work] = manual.getFacts(GROUP, USER);
    hits = [
      { id: 'u-game', score: 0.6 },
      { id: game.id, score: 0.55 },
      { id: work.id, score: 0.2 },
    ];

    const result = await memory.searchMemory(GROUP, '玩什么游戏', { includeGroupMemory: false, limit: 5 });

    expect(result.count).toBe(2);
    expect(result.text).toBe(
      `用户 ${USER} 的记忆:\n[preference:game]\n- 最近在玩星穹铁道（人工维护）\n- 长期玩战双`,
    );
  });

  it('matches substrings of both layers without an index', async () => {
    const memory = service(false);
    await manual.save(GROUP, USER, '[preference:game]\n最近在玩星穹铁道');

    const result = await memory.searchMemory(GROUP, '玩', { includeGroupMemory: true, limit: 5 });

    expect(result.count).toBe(2);
    expect(result.text).toContain('最近在玩星穹铁道（人工维护）');
    expect(result.text).toContain('长期玩战双');
  });
});

describe('MemoryRetrievalService.getMemoryForPrivateReply', () => {
  const OTHER_GROUP = '100000002';
  const MANUAL_ONLY_GROUP = '100000003';
  let dir: string;
  const facts = [
    fact('g-rule', GROUP_MEMORY_USER_ID, 'rule:bot', '回复里不要用 emoji'),
    fact('a-inst', USER, 'instruction', '回答前先核实'),
    fact('a-game', USER, 'preference:game', '长期玩战双'),
    fact('b-inst', USER, 'instruction', '回答前先核实', { groupId: OTHER_GROUP }),
    fact('b-work', USER, 'identity:work', '在做运营商相关工作', { groupId: OTHER_GROUP }),
    fact('b-food', USER, 'preference:food', '不吃辣', { groupId: OTHER_GROUP }),
  ];
  const searchedGroups: string[] = [];
  const searches: MemorySearchOptions[] = [];

  const store = {
    listUserFacts: async (userId: string) => facts.filter((f) => f.userId === userId),
    recordHits: async () => {},
  } as unknown as MemoryFactStore;

  function service(hits: Array<MemorySearchHit & { groupId: string }>): {
    memory: MemoryRetrievalService;
    manual: ManualMemoryStore;
  } {
    const index = {
      isEnabled: () => true,
      search: async (groupId: string, _q: string, options: MemorySearchOptions) => {
        searchedGroups.push(groupId);
        searches.push(options);
        return hits.filter((hit) => hit.groupId === groupId);
      },
    } as unknown as MemoryIndex;
    const config = { getMemoryConfig: () => ({ dir }) } as unknown as Config;
    const manual = new ManualMemoryStore(config);
    return { memory: new MemoryRetrievalService(config, store, index, manual), manual };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    searchedGroups.length = 0;
    searches.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries the person's memory from every group, once, and no group memory", async () => {
    const hits: Array<MemorySearchHit & { groupId: string }> = [
      { id: 'a-game', score: 0.6, groupId: GROUP },
      { id: 'b-work', score: 0.55, groupId: OTHER_GROUP },
    ];
    const { memory, manual } = service(hits);
    await manual.save(GROUP, USER, '[instruction]\n称呼我为甲');
    await manual.save(OTHER_GROUP, USER, '[instruction]\n称呼我为甲\n不要剧透');
    await manual.save(MANUAL_ONLY_GROUP, USER, '[identity:work]\n做前端开发\n\n[preference:food]\n爱吃甜食');
    await manual.save(GROUP, GROUP_MEMORY_USER_ID, '[rule]\n本群禁止刷屏');
    const [work] = manual.getFacts(MANUAL_ONLY_GROUP, USER);
    hits.push({ id: work.id, score: 0.5, groupId: MANUAL_ONLY_GROUP });

    const text = await memory.getMemoryForPrivateReply(USER, '你还记得我做什么工作吗');

    expect(text).toBe(
      [
        '【人工维护，与其他条目冲突时以此为准】',
        '[identity:work]',
        '- 做前端开发',
        '',
        '[instruction]',
        '- 称呼我为甲',
        '- 不要剧透',
        '',
        '【自动整理】',
        '[identity:work]',
        '- 在做运营商相关工作',
        '',
        '[preference:game]',
        '- 长期玩战双',
        '',
        '[instruction]',
        '- 回答前先核实',
      ].join('\n'),
    );
    expect(searchedGroups.sort()).toEqual([GROUP, OTHER_GROUP, MANUAL_ONLY_GROUP]);
    expect(searches[0].owners).toEqual({ userId: USER, includeGroup: false });
  });
});

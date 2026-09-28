import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@/core/config';
import { GROUP_MEMORY_USER_ID } from '../../model/constants';
import { ManualMemoryStore } from '../ManualMemoryStore';

const GROUP = '100000001';
const USER = '10000001';

describe('ManualMemoryStore', () => {
  let dir: string;
  let store: ManualMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manual-memory-test-'));
    store = new ManualMemoryStore({ getMemoryConfig: () => ({ dir }) } as unknown as Config);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives an unchanged line the same id across edits and an edited line a new one', async () => {
    await store.save(GROUP, USER, '[identity:work]\n做前端开发\n\n[preference:food]\n爱吃甜食');
    const [work, food] = store.getFacts(GROUP, USER);

    await store.save(GROUP, USER, '[identity:work]\n做前端开发\n\n[preference:food]\n不吃辣');
    const [workAfter, foodAfter] = store.getFacts(GROUP, USER);

    expect(workAfter.id).toBe(work.id);
    expect(foodAfter.id).not.toBe(food.id);
    expect(workAfter).toMatchObject({ groupId: GROUP, userId: USER, scope: 'identity:work', content: '做前端开发' });
  });

  it('keeps a line repeated under one scope once, and tells scopes and slots apart', async () => {
    await store.save(GROUP, USER, '[identity:work]\n做前端开发\n做前端开发\n\n[opinion:work]\n做前端开发');
    await store.save(GROUP, GROUP_MEMORY_USER_ID, '[identity:work]\n做前端开发');

    const userFacts = store.getFacts(GROUP, USER);
    const [groupFact] = store.getFacts(GROUP, GROUP_MEMORY_USER_ID);

    expect(userFacts.map((f) => f.scope)).toEqual(['identity:work', 'opinion:work']);
    expect(new Set([...userFacts.map((f) => f.id), groupFact.id]).size).toBe(3);
  });

  it('maps a manual.txt path under its directory back to the slot', () => {
    expect(store.slotAt(`${GROUP}/${USER}/manual.txt`)).toEqual({ groupId: GROUP, userId: USER });
    expect(store.slotAt(`${GROUP}/_global_/manual.txt`)).toEqual({ groupId: GROUP, userId: GROUP_MEMORY_USER_ID });
    expect(store.slotAt(`${GROUP}/${USER}/auto.migrated.txt`)).toBeNull();
    expect(store.slotAt(`${GROUP}/${USER}`)).toBeNull();
  });
});

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@/core/config';
import { ManualMemoryStore } from '../ManualMemoryStore';
import type { MemoryFactStore } from '../MemoryFactStore';
import type { IndexedFact, MemoryIndex, SourcedFacts } from '../MemoryIndex';
import { MemoryIndexSync } from '../MemoryIndexSync';

const GROUP = '100000001';
const USER = '10000001';

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await Bun.sleep(50);
  }
}

describe('MemoryIndexSync', () => {
  let dir: string;
  let manual: ManualMemoryStore;
  let sync: MemoryIndexSync;
  const reconciled: Array<{ groupId: string; wanted: SourcedFacts }> = [];
  const slotSyncs: Array<{ groupId: string; userId: string; contents: string[] }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-sync-test-'));
    reconciled.length = 0;
    slotSyncs.length = 0;
    manual = new ManualMemoryStore({ getMemoryConfig: () => ({ dir }) } as unknown as Config);
    const facts = {
      listGroupIds: async () => [],
      listGroup: async () => [],
    } as unknown as MemoryFactStore;
    const index = {
      isEnabled: () => true,
      reconcile: async (groupId: string, wanted: SourcedFacts) => {
        reconciled.push({ groupId, wanted });
        return { upserted: 0, removed: 0 };
      },
      reconcileManualSlot: async (groupId: string, userId: string, slotFacts: IndexedFact[]) => {
        slotSyncs.push({ groupId, userId, contents: slotFacts.map((f) => f.content) });
        return { upserted: slotFacts.length, removed: 0 };
      },
    } as unknown as MemoryIndex;
    sync = new MemoryIndexSync(facts, manual, index);
  });

  afterEach(async () => {
    await sync.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reindexes groups that only have manual memory', async () => {
    await manual.save(GROUP, USER, '[identity:work]\n做前端开发');

    expect(await sync.listGroupIds()).toEqual([GROUP]);
    await sync.reindexGroup(GROUP);

    expect(reconciled[0].wanted.manual.map((f) => f.content)).toEqual(['做前端开发']);
  });

  it('reconciles a slot after its manual.txt is edited', async () => {
    sync.start();
    await Bun.sleep(100);

    await manual.save(GROUP, USER, '[identity:work]\n做前端开发');

    await until(() => slotSyncs.length > 0);
    expect(slotSyncs.at(-1)).toEqual({ groupId: GROUP, userId: USER, contents: ['做前端开发'] });
  });
});

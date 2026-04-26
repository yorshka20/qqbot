import { describe, expect, test } from 'bun:test';
import { classifyAffinityDelta, RelationshipUpdater } from '../RelationshipUpdater';

// ─── classifyAffinityDelta ────────────────────────────────────────────────────

describe('classifyAffinityDelta', () => {
  test('positive keywords → +0.01', () => {
    expect(classifyAffinityDelta('谢谢，太喜欢了')).toBeCloseTo(0.01, 10);
  });

  test('negative keywords → -0.01', () => {
    expect(classifyAffinityDelta('你不对，抬杠')).toBeCloseTo(-0.01, 10);
  });

  test('no keywords → 0', () => {
    expect(classifyAffinityDelta('今天天气真好')).toBe(0);
  });

  test('positive keyword 666 → +0.01', () => {
    expect(classifyAffinityDelta('666 牛啊')).toBeCloseTo(0.01, 10);
  });

  test('negative keyword 烦 → -0.01', () => {
    expect(classifyAffinityDelta('好烦啊')).toBeCloseTo(-0.01, 10);
  });

  test('positive wins when only positive keywords present', () => {
    expect(classifyAffinityDelta('真棒可爱')).toBeCloseTo(0.01, 10);
  });

  test('empty string → 0', () => {
    expect(classifyAffinityDelta('')).toBe(0);
  });
});

// ─── RelationshipUpdater integration-level (mock store) ───────────────────────

// Minimal mock for EpigeneticsStore needed by RelationshipUpdater.
class MockStore {
  readonly calls: Array<{
    personaId: string;
    userId: string;
    delta: { affinityDelta?: number; familiarityDelta?: number };
  }> = [];

  async bumpRelationship(
    personaId: string,
    userId: string,
    delta: { affinityDelta?: number; familiarityDelta?: number },
  ): Promise<void> {
    this.calls.push({ personaId, userId, delta });
  }
}

describe('RelationshipUpdater.update', () => {
  test('positive message → affinityDelta=+0.01, familiarityDelta=0.001', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('default', 'user1', '谢谢，太喜欢了');
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].delta.affinityDelta).toBeCloseTo(0.01, 10);
    expect(store.calls[0].delta.familiarityDelta).toBeCloseTo(0.001, 10);
  });

  test('negative message → affinityDelta=-0.01', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('default', 'user1', '你不对，抬杠');
    expect(store.calls[0].delta.affinityDelta).toBeCloseTo(-0.01, 10);
    expect(store.calls[0].delta.familiarityDelta).toBeCloseTo(0.001, 10);
  });

  test('neutral message → affinityDelta=0, familiarityDelta=0.001', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('default', 'user1', '今天天气真好');
    expect(store.calls[0].delta.affinityDelta).toBe(0);
    expect(store.calls[0].delta.familiarityDelta).toBeCloseTo(0.001, 10);
  });

  test('100 neutral messages accumulate familiarity to 0.1', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    for (let i = 0; i < 100; i++) {
      await updater.update('default', 'user1', '今天天气真好');
    }
    const totalFamiliarity = store.calls.reduce((acc, c) => acc + (c.delta.familiarityDelta ?? 0), 0);
    expect(totalFamiliarity).toBeCloseTo(0.1, 5);
  });

  test('personaId and userId are forwarded to store', async () => {
    const store = new MockStore();
    const updater = new RelationshipUpdater(store as never);
    await updater.update('persona-x', 'user-42', '');
    expect(store.calls[0].personaId).toBe('persona-x');
    expect(store.calls[0].userId).toBe('user-42');
  });
});

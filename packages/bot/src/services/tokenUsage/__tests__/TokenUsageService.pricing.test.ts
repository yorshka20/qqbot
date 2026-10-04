import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { Config, ModelPricingEntry } from '@/core/config';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { TokenUsageRecord } from '@/database/models/types';
import { type TokenUsageEvent, TokenUsageService } from '../TokenUsageService';

const PRICING: Record<string, ModelPricingEntry> = {
  'text-model': { input: 1, cachedInput: 0.1, output: 4 },
  'uncached-model': { input: 1, output: 4 },
  'image-model': { perImage: 0.15 },
  'family-*': { input: 2, output: 2 },
};

function makeService() {
  const rows: TokenUsageRecord[] = [];
  const model = {
    async create(record: Omit<TokenUsageRecord, 'id' | 'createdAt' | 'updatedAt'>) {
      const row = { ...record, id: String(rows.length), createdAt: new Date(), updatedAt: new Date() };
      rows.push(row);
      return row;
    },
    async find(filter: Partial<TokenUsageRecord>) {
      return rows.filter((row) =>
        Object.entries(filter).every(([key, value]) => row[key as keyof TokenUsageRecord] === value),
      );
    },
  };
  const databaseManager = { getAdapter: () => ({ getModel: () => model }) } as unknown as DatabaseManager;
  const config = { getAIConfig: () => ({ providers: {}, modelPricing: PRICING }) } as unknown as Config;
  return new TokenUsageService(databaseManager, config);
}

function event(overrides: Partial<TokenUsageEvent>): TokenUsageEvent {
  return {
    userId: '20000001',
    groupId: '10000001',
    protocol: 'milky',
    provider: 'deepseek',
    type: 'llm',
    source: 'reply',
    ...overrides,
  };
}

describe('TokenUsageService pricing', () => {
  it('prices cached prompt tokens at the cache rate and the rest at full input', async () => {
    const service = makeService();

    const cost = await service.record(
      event({ model: 'text-model', promptTokens: 1_000_000, cachedPromptTokens: 800_000, completionTokens: 100_000 }),
    );

    // 200K uncached × $1 + 800K cached × $0.1 + 100K output × $4
    expect(cost).toBeCloseTo(0.2 + 0.08 + 0.4, 10);
  });

  it('bills cached tokens at full input when the model has no cache rate', async () => {
    const service = makeService();

    const cost = await service.record(
      event({ model: 'uncached-model', promptTokens: 1_000_000, cachedPromptTokens: 800_000, completionTokens: 0 }),
    );

    expect(cost).toBeCloseTo(1, 10);
  });

  it('prices images per generated image', async () => {
    const service = makeService();

    const cost = await service.record(event({ model: 'image-model', type: 'image', source: 'image', imageCount: 2 }));

    expect(cost).toBeCloseTo(0.3, 10);
  });

  it('matches a trailing-wildcard entry and leaves unknown models free', async () => {
    const service = makeService();

    expect(await service.record(event({ model: 'family-large', promptTokens: 500_000 }))).toBeCloseTo(1, 10);
    expect(await service.record(event({ model: 'unpriced', promptTokens: 500_000 }))).toBe(0);
  });

  it('sums a group’s day by user, highest spender first', async () => {
    const service = makeService();
    const date = service.getLocalDate();
    await service.record(event({ userId: 'a', nickname: '甲', model: 'image-model', type: 'image', imageCount: 1 }));
    await service.record(event({ userId: 'b', nickname: '乙', model: 'image-model', type: 'image', imageCount: 2 }));
    await service.record(event({ userId: 'b', groupId: '10000002', model: 'image-model', imageCount: 5 }));

    const spend = await service.getGroupSpend('10000001', date);

    expect(spend.cost).toBeCloseTo(0.45, 10);
    expect(spend.users.map((u) => [u.nickname, Number(u.cost.toFixed(2))])).toEqual([
      ['乙', 0.3],
      ['甲', 0.15],
    ]);
    expect(await service.getUserCost('b', date)).toBeCloseTo(1.05, 10);
  });
});

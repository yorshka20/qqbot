import 'reflect-metadata';
import { describe, expect, it, spyOn } from 'bun:test';
import { logger } from '@qqbot/shared';
import type { Config, ModelPricingEntry } from '@/core/config';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { TokenUsageRecord } from '@/database/models/types';
import { SYSTEM_USER_ID, type TokenUsageEvent, TokenUsageService } from '../TokenUsageService';

const PRICING: Record<string, ModelPricingEntry> = {
  'text-model': { input: 1, cachedInput: 0.1, output: 4 },
  'uncached-model': { input: 1, output: 4 },
  'image-model': { perImage: 0.15 },
  'token-image-model': { input: 8, cachedInput: 2, output: 30 },
  'discounted-model': { input: 2, cachedInput: 0.2, output: 10, budgetMultiplier: 0.1 },
  'free-model': { input: 0, output: 0 },
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
    async update(id: string, data: Partial<TokenUsageRecord>) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, data);
      return row;
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

  it('prices an image model that reports tokens by its token rates, not per image', async () => {
    const service = makeService();

    const cost = await service.record(
      event({
        model: 'token-image-model',
        type: 'image',
        source: 'image',
        imageCount: 1,
        promptTokens: 1000,
        completionTokens: 1056,
      }),
    );

    // 1000 input × $8/1M + 1056 output × $30/1M — nowhere near a flat $0.15 per image
    expect(cost).toBeCloseTo(0.008 + 0.03168, 10);
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
    expect(await service.getUserBudgetSpend('b', date)).toBeCloseTo(1.05, 10);
  });

  it('waiving a user’s budget drops their spend from the cap but keeps it in the report', async () => {
    const service = makeService();
    const date = service.getLocalDate();
    await service.record(event({ userId: 'a', model: 'text-model', promptTokens: 1_000_000 }));

    const waived = await service.waiveUserBudget('a', date);

    expect(waived).toEqual({ waivedRows: 1, waivedCost: 1 });
    expect(await service.getUserBudgetSpend('a', date)).toBe(0);
    expect((await service.getDailyReport(date, 10)).cost).toBeCloseTo(1, 10);
    // A second reset has nothing left to waive.
    expect(await service.waiveUserBudget('a', date)).toEqual({ waivedRows: 0, waivedCost: 0 });
  });

  describe('budgetMultiplier', () => {
    async function recordDiscounted() {
      const service = makeService();
      const date = service.getLocalDate();
      const cost = await service.record(
        event({ userId: 'a', model: 'discounted-model', promptTokens: 1_000_000, completionTokens: 0 }),
      );
      return { service, date, cost };
    }

    it('scales only what counts against the cap', async () => {
      const { service, date } = await recordDiscounted();

      expect(await service.getUserBudgetSpend('a', date)).toBeCloseTo(0.2, 10);
      expect((await service.waiveUserBudget('a', date)).waivedCost).toBeCloseTo(0.2, 10);
    });

    it('keeps every reported cost at the official price', async () => {
      const { service, date, cost } = await recordDiscounted();

      expect(cost).toBeCloseTo(2, 10);
      expect((await service.getGroupSpend('10000001', date)).cost).toBeCloseTo(2, 10);
      expect((await service.getDailyReport(date, 10)).cost).toBeCloseTo(2, 10);
      expect((await service.getUserDailyBreakdown('a', [date]))[0].cost).toBeCloseTo(2, 10);
    });
  });

  describe('unpriced models', () => {
    async function seed() {
      const service = makeService();
      const tokens = { promptTokens: 10, completionTokens: 5 };
      await service.record(event({ model: 'text-model', ...tokens }));
      await service.record(event({ model: 'free-model', ...tokens }));
      await service.record(event({ model: 'zz-unpriced', ...tokens }));
      await service.record(event({ model: 'aa-unpriced', userId: '20000002', ...tokens }));
      await service.record(event({ model: 'aa-unpriced', ...tokens }));
      return service;
    }

    it('lists unpriced models in the daily report across all users, not just the top-N', async () => {
      const service = await seed();
      const report = await service.getDailyReport(service.getLocalDate(), 1);

      expect(report.unpricedModels).toEqual(['aa-unpriced', 'zz-unpriced']);
    });

    it('lists unpriced models in the per-user breakdown and omits priced and zero-priced ones', async () => {
      const service = await seed();
      const [day] = await service.getUserDailyBreakdown('20000001', [service.getLocalDate()]);

      expect(day.unpricedModels).toEqual(['aa-unpriced', 'zz-unpriced']);
    });

    it('lists a row without a model as (unknown)', async () => {
      const service = makeService();
      await service.record(event({ promptTokens: 10 }));
      const report = await service.getDailyReport(service.getLocalDate(), 5);

      expect(report.unpricedModels).toEqual(['(unknown)']);
    });

    it('warns once per unpriced model and never for a priced one', async () => {
      const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
      try {
        const service = makeService();
        await service.record(event({ model: 'zz-unpriced', promptTokens: 10 }));
        await service.record(event({ model: 'zz-unpriced', promptTokens: 10 }));
        await service.record(event({ model: 'free-model', promptTokens: 10 }));
        await service.record(event({ model: 'text-model', promptTokens: 10 }));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('zz-unpriced');
        expect(String(warn.mock.calls[0][0])).toContain('deepseek');
      } finally {
        warn.mockRestore();
      }
    });

    it('still prices an unpriced model at 0', async () => {
      const service = makeService();
      expect(await service.record(event({ model: 'zz-unpriced', promptTokens: 1_000_000 }))).toBe(0);
    });
  });
});

describe('TokenUsageService.recordSystemLLM', () => {
  it('stores a groupless row under the system user that the report shows but no spend counts', async () => {
    const service = makeService();
    await service.record(event({ promptTokens: 1000, completionTokens: 100, model: 'text-model' }));
    const userBefore = await service.getUserBudgetSpend('20000001', service.getLocalDate());
    const groupBefore = await service.getGroupSpend('10000001', service.getLocalDate());

    await service.recordSystemLLM({
      provider: 'deepseek',
      model: 'text-model',
      usage: { promptTokens: 5000, completionTokens: 500, totalTokens: 5500, cachedPromptTokens: 2000 },
    });

    const day = service.getLocalDate();
    const report = await service.getDailyReport(day, 10);
    const system = report.topUsers.find((u) => u.userId === SYSTEM_USER_ID);
    expect(system?.totalTokens).toBe(5500);
    expect(system?.nickname).toBe('系统');
    expect(await service.getUserBudgetSpend('20000001', day)).toBe(userBefore);
    expect(await service.getGroupSpend('10000001', day)).toEqual(groupBefore);
  });
});

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { Config } from '@/core/config';
import type { AIUsageConfig } from '@/core/config/types/ai';
import type { GroupSpend, TokenUsageEvent, TokenUsageService } from '../TokenUsageService';
import { UsageNoticeService } from '../UsageNoticeService';

const GROUP_ID = '10000001';
const SESSION = { sessionId: `group:${GROUP_ID}` };

/** In-memory usage store: each event costs whatever its promptTokens say, in cents. */
function makeUsageService(options: { lookupDelayMs?: (n: number) => number } = {}) {
  const rows: Array<{ userId: string; groupId?: string; cost: number }> = [];
  let lookups = 0;
  const service = {
    getLocalDate: () => '2026-01-01',
    async record(event: TokenUsageEvent): Promise<number | null> {
      const cost = (event.promptTokens ?? 0) / 100;
      rows.push({
        userId: String(event.userId),
        groupId: event.groupId != null ? String(event.groupId) : undefined,
        cost,
      });
      return cost;
    },
    async getGroupSpend(groupId: string): Promise<GroupSpend> {
      const delay = options.lookupDelayMs?.(lookups++) ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const byUser = new Map<string, number>();
      for (const row of rows.filter((r) => r.groupId === groupId)) {
        byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + row.cost);
      }
      const users = [...byUser.entries()]
        .map(([userId, cost]) => ({ userId, nickname: `甲${userId}`, cost }))
        .sort((a, b) => b.cost - a.cost);
      return { cost: users.reduce((sum, u) => sum + u.cost, 0), users };
    },
  };
  return { service: service as unknown as TokenUsageService, rows };
}

function makeConfig(usage: AIUsageConfig | undefined): Config {
  return { getAIConfig: () => ({ providers: {}, usage }) } as unknown as Config;
}

/** `groupId: null` is a private chat. */
function spendEvent(cents: number, userId = '20000001', groupId: string | null = GROUP_ID): TokenUsageEvent {
  return {
    userId,
    groupId: groupId ?? undefined,
    protocol: 'milky',
    provider: 'deepseek',
    model: 'deepseek-flash',
    type: 'llm',
    source: 'reply',
    promptTokens: cents,
    completionTokens: 0,
  };
}

describe('UsageNoticeService — group spend steps', () => {
  it('announces each step once, as the day crosses it', async () => {
    const { service } = makeUsageService();
    const notices = new UsageNoticeService(service, makeConfig({ groupSpendStepUsd: 1 }));

    expect(await notices.record(spendEvent(60), SESSION)).toEqual([]);
    const crossing = await notices.record(spendEvent(60), SESSION);
    expect(await notices.record(spendEvent(30), SESSION)).toEqual([]);

    expect(crossing).toHaveLength(1);
    expect(crossing[0]).toContain('已过 $1（累计 $1.20）');
  });

  it('names the highest step when one call jumps past several', async () => {
    const { service } = makeUsageService();
    const notices = new UsageNoticeService(service, makeConfig({ groupSpendStepUsd: 1 }));

    const [notice] = await notices.record(spendEvent(250), SESSION);

    expect(notice).toContain('已过 $2（累计 $2.50）');
  });

  it('lists the day’s top spenders', async () => {
    const { service } = makeUsageService();
    const notices = new UsageNoticeService(service, makeConfig({ groupSpendStepUsd: 1 }));

    await notices.record(spendEvent(30, '20000002'), SESSION);
    const [notice] = await notices.record(spendEvent(80, '20000001'), SESSION);

    expect(notice).toContain('甲20000001 $0.80 · 甲20000002 $0.30');
  });

  it('announces a step crossed by two concurrent records only once', async () => {
    // The first record's spend lookup is slow, so without per-group ordering the second row
    // lands before it reads, and both records see the step crossed by their own row.
    const { service } = makeUsageService({ lookupDelayMs: (n) => (n === 1 ? 20 : 0) });
    const notices = new UsageNoticeService(service, makeConfig({ groupSpendStepUsd: 1 }));
    await notices.record(spendEvent(90), SESSION);

    const results = await Promise.all([
      notices.record(spendEvent(6), SESSION),
      notices.record(spendEvent(6), SESSION),
    ]);

    expect(results.flat()).toHaveLength(1);
  });

  it('records private-chat usage without a spend notice', async () => {
    const { service, rows } = makeUsageService();
    const notices = new UsageNoticeService(service, makeConfig({ groupSpendStepUsd: 1 }));

    const result = await notices.record(spendEvent(500, '20000001', null), { sessionId: 'user:20000001' });

    expect(result).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('only records when no step is configured', async () => {
    const { service, rows } = makeUsageService();
    const notices = new UsageNoticeService(service, makeConfig(undefined));

    expect(await notices.record(spendEvent(500), SESSION)).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe('UsageNoticeService — prompt size', () => {
  const config = makeConfig({ promptAlertTokens: 60_000, promptAlertCooldownMinutes: 30 });

  it('alerts when the opening prompt reaches the line, pointing at /compress', async () => {
    const notices = new UsageNoticeService(makeUsageService().service, config);

    expect(await notices.record(spendEvent(1), { ...SESSION, openingPromptTokens: 59_999 })).toEqual([]);
    const [notice] = await notices.record(spendEvent(1), { ...SESSION, openingPromptTokens: 61_200 });

    expect(notice).toContain('61.2K tokens（提醒线 60.0K）');
    expect(notice).toContain('/compress');
  });

  it('stays quiet within the cooldown, per session', async () => {
    const notices = new UsageNoticeService(makeUsageService().service, config);
    const big = { openingPromptTokens: 70_000 };

    await notices.record(spendEvent(1), { ...SESSION, ...big });
    const repeat = await notices.record(spendEvent(1), { ...SESSION, ...big });
    const otherSession = await notices.record(spendEvent(1), { sessionId: 'group:10000002', ...big });

    expect(repeat).toEqual([]);
    expect(otherSession).toHaveLength(1);
  });
});

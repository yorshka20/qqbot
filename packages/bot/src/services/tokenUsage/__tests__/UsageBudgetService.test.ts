import 'reflect-metadata';
import { describe, expect, it, vi } from 'bun:test';
import type { Config } from '@/core/config';
import type { AIUsageConfig } from '@/core/config/types/ai';
import type { PermissionChecker } from '@/permission';
import type { TokenUsageService } from '../TokenUsageService';
import { UsageBudgetService } from '../UsageBudgetService';

const ADMIN_ID = '10000001';

function makeBudget(usage: AIUsageConfig | undefined, spentByUser: Record<string, number>) {
  const usageService = {
    getLocalDate: () => '2026-01-01',
    getUserCost: vi.fn(async (userId: string) => spentByUser[userId] ?? 0),
  } as unknown as TokenUsageService;
  const permissionChecker = { isAdmin: (userId: string) => userId === ADMIN_ID } as unknown as PermissionChecker;
  const config = { getAIConfig: () => ({ providers: {}, usage }) } as unknown as Config;
  return { budget: new UsageBudgetService(usageService, permissionChecker, config), usageService };
}

describe('UsageBudgetService', () => {
  it('refuses a user whose spend today has reached the cap', async () => {
    const { budget } = makeBudget({ userDailyLimitUsd: 0.5 }, { '20000001': 0.5 });

    expect(await budget.checkUser('20000001', 'milky')).toEqual({ spentUsd: 0.5, limitUsd: 0.5 });
  });

  it('lets a user under the cap through', async () => {
    const { budget } = makeBudget({ userDailyLimitUsd: 0.5 }, { '20000001': 0.49 });

    expect(await budget.checkUser('20000001', 'milky')).toBeNull();
  });

  it('never caps an admin, whatever they spent', async () => {
    const { budget, usageService } = makeBudget({ userDailyLimitUsd: 0.5 }, { [ADMIN_ID]: 50 });

    expect(await budget.checkUser(ADMIN_ID, 'milky')).toBeNull();
    expect(usageService.getUserCost).not.toHaveBeenCalled();
  });

  it('applies a per-user override over the default cap', async () => {
    const { budget } = makeBudget(
      { userDailyLimitUsd: 0.5, userDailyLimitOverrides: { '20000001': 2 } },
      { '20000001': 1.5, '20000002': 1.5 },
    );

    expect(await budget.checkUser('20000001', 'milky')).toBeNull();
    expect(await budget.checkUser('20000002', 'milky')).toEqual({ spentUsd: 1.5, limitUsd: 0.5 });
  });

  it('caps nobody when no limit is configured', async () => {
    const { budget, usageService } = makeBudget(undefined, { '20000001': 50 });

    expect(await budget.checkUser('20000001', 'milky')).toBeNull();
    expect(usageService.getUserCost).not.toHaveBeenCalled();
  });
});

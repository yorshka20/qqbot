// Per-user daily spend caps. A user past their cap gets no LLM reply until the day turns.
// Admins are never capped; their usage is still recorded like everyone else's.

import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import type { PermissionChecker } from '@/permission';
import { TokenUsageService } from './TokenUsageService';

export interface BudgetExceeded {
  spentUsd: number;
  limitUsd: number;
}

@singleton()
export class UsageBudgetService {
  private readonly defaultLimitUsd: number | undefined;
  private readonly limitOverrides: Record<string, number>;

  constructor(
    @inject(TokenUsageService) private readonly usageService: TokenUsageService,
    @inject(DITokens.PERMISSION_CHECKER) private readonly permissionChecker: PermissionChecker,
    @inject(DITokens.CONFIG) config: Config,
  ) {
    const usage = config.getAIConfig()?.usage;
    this.defaultLimitUsd = usage?.userDailyLimitUsd;
    this.limitOverrides = usage?.userDailyLimitOverrides ?? {};
  }

  /** The user's spend and cap for today when they have used it up; null while they may still spend. */
  async checkUser(userId: string, protocol: string): Promise<BudgetExceeded | null> {
    if (this.permissionChecker.isAdmin(userId, protocol)) {
      return null;
    }
    const limitUsd = this.limitOverrides[userId] ?? this.defaultLimitUsd;
    if (limitUsd == null) {
      return null;
    }
    const spentUsd = await this.usageService.getUserCost(userId, this.usageService.getLocalDate());
    return spentUsd >= limitUsd ? { spentUsd, limitUsd } : null;
  }
}

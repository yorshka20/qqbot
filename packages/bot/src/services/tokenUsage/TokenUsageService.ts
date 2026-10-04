// Per-user token / image consumption tracking.
//
// One row is written per user-triggered LLM call (incl. subagent / tool-loop
// iterations) and per image-generation call. Recording never throws: a
// persistence failure must never break reply generation. Aggregation happens at
// read time (modest volume; keeps the schema flexible and adapter-agnostic).

import { inject, singleton } from 'tsyringe';
import type { Config, ModelPricingEntry } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { DatabaseManager } from '@/database/DatabaseManager';
import type { TokenUsageRecord } from '@/database/models/types';
import { logger } from '@/utils/logger';

export interface TokenUsageEvent {
  userId: string | number;
  nickname?: string;
  groupId?: string | number;
  protocol: string;
  provider: string;
  model?: string;
  type: 'llm' | 'image';
  /** Origin of the call: 'reply' | 'subagent' | 'command:gpt2' | 'tool:generate_image' ... */
  source: string;
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  imageCount?: number;
}

type PricedUsage = Pick<
  TokenUsageRecord,
  'model' | 'promptTokens' | 'cachedPromptTokens' | 'completionTokens' | 'imageCount'
>;

export interface ProviderUsageAgg {
  provider: string;
  type: 'llm' | 'image';
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  imageCount: number;
  /** Estimated cost in USD. 0 when pricing is not configured for the model. */
  cost: number;
}

export interface UserUsageAgg {
  userId: string;
  nickname?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalImages: number;
  cost: number;
  byProvider: ProviderUsageAgg[];
}

/** All-user totals for a day plus the top-N users. */
export interface DailyReport {
  date: string;
  userCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalImages: number;
  cost: number;
  topUsers: UserUsageAgg[];
}

export interface UserSpend {
  userId: string;
  nickname?: string;
  cost: number;
}

/** One group's priced spend for a day, with each user's share (highest first). */
export interface GroupSpend {
  cost: number;
  users: UserSpend[];
}

export interface DailyUsageAgg {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalImages: number;
  cost: number;
  byProvider: ProviderUsageAgg[];
}

@singleton()
export class TokenUsageService {
  constructor(
    @inject(DatabaseManager) private databaseManager: DatabaseManager,
    @inject(DITokens.CONFIG) private config: Config,
  ) {}

  /** YYYY-MM-DD in local timezone, `offsetDays` ago (0 = today). */
  getLocalDate(offsetDays = 0): string {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Record one usage event and return the priced cost of the stored row. Never throws:
   * resolves null when the row was not stored. Skips no-op events (zero tokens AND zero
   * images) so failed/empty provider responses don't pollute the stats.
   */
  async record(event: TokenUsageEvent): Promise<number | null> {
    const promptTokens = event.promptTokens ?? 0;
    const completionTokens = event.completionTokens ?? 0;
    const totalTokens = event.totalTokens ?? promptTokens + completionTokens;
    const imageCount = event.imageCount ?? 0;
    if (totalTokens <= 0 && imageCount <= 0) {
      return null;
    }

    const record: Omit<TokenUsageRecord, 'id' | 'createdAt' | 'updatedAt'> = {
      date: this.getLocalDate(),
      userId: String(event.userId),
      nickname: event.nickname,
      groupId: event.groupId != null ? String(event.groupId) : undefined,
      protocol: event.protocol,
      provider: event.provider,
      model: event.model,
      type: event.type,
      source: event.source,
      promptTokens,
      cachedPromptTokens: event.cachedPromptTokens ?? 0,
      completionTokens,
      totalTokens,
      imageCount,
    };

    try {
      await this.databaseManager.getAdapter().getModel('tokenUsage').create(record);
    } catch (err) {
      logger.warn('[TokenUsageService] Failed to persist usage record:', err);
      return null;
    }
    return this.priceUsage(record);
  }

  /** One user's priced spend on `date`, across every group and private chat. */
  async getUserCost(userId: string, date: string): Promise<number> {
    const rows = await this.databaseManager.getAdapter().getModel('tokenUsage').find({ date, userId });
    return rows.reduce((sum, row) => sum + this.priceUsage(row), 0);
  }

  async getGroupSpend(groupId: string, date: string): Promise<GroupSpend> {
    const rows = await this.databaseManager.getAdapter().getModel('tokenUsage').find({ date, groupId });
    const byUser = new Map<string, UserSpend>();
    // Oldest first, so the latest non-empty nickname is the one left standing.
    for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const spend = byUser.get(row.userId) ?? { userId: row.userId, cost: 0 };
      spend.cost += this.priceUsage(row);
      if (row.nickname) {
        spend.nickname = row.nickname;
      }
      byUser.set(row.userId, spend);
    }
    const users = [...byUser.values()].sort((a, b) => b.cost - a.cost);
    return { cost: users.reduce((sum, u) => sum + u.cost, 0), users };
  }

  /**
   * Full daily report: all-user totals (accurate, not limited to top-N) plus the
   * top-N users by total token consumption, each with per-provider breakdown.
   */
  async getDailyReport(date: string, limit: number): Promise<DailyReport> {
    const rows = await this.databaseManager.getAdapter().getModel('tokenUsage').find({ date });

    const byUser = new Map<string, TokenUsageRecord[]>();
    for (const row of rows) {
      const list = byUser.get(row.userId);
      if (list) list.push(row);
      else byUser.set(row.userId, [row]);
    }

    const aggs: UserUsageAgg[] = [];
    for (const [userId, userRows] of byUser) {
      const byProvider = this.aggregateByProvider(userRows);
      // Latest non-empty nickname wins (createdAt desc).
      const nickname = [...userRows]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .find((r) => r.nickname)?.nickname;
      aggs.push({
        userId,
        nickname,
        promptTokens: byProvider.reduce((s, p) => s + p.promptTokens, 0),
        completionTokens: byProvider.reduce((s, p) => s + p.completionTokens, 0),
        totalTokens: byProvider.reduce((s, p) => s + p.totalTokens, 0),
        totalImages: byProvider.reduce((s, p) => s + p.imageCount, 0),
        cost: byProvider.reduce((s, p) => s + p.cost, 0),
        byProvider,
      });
    }

    aggs.sort((a, b) => b.totalTokens - a.totalTokens || b.totalImages - a.totalImages);

    return {
      date,
      userCount: aggs.length,
      promptTokens: aggs.reduce((s, u) => s + u.promptTokens, 0),
      completionTokens: aggs.reduce((s, u) => s + u.completionTokens, 0),
      totalTokens: aggs.reduce((s, u) => s + u.totalTokens, 0),
      totalImages: aggs.reduce((s, u) => s + u.totalImages, 0),
      cost: aggs.reduce((s, u) => s + u.cost, 0),
      topUsers: aggs.slice(0, limit),
    };
  }

  /** Per-day breakdown for a single user across the given dates (newest first as passed in). */
  async getUserDailyBreakdown(userId: string, dates: string[]): Promise<DailyUsageAgg[]> {
    const model = this.databaseManager.getAdapter().getModel('tokenUsage');
    const out: DailyUsageAgg[] = [];
    for (const date of dates) {
      const rows = await model.find({ date, userId });
      const byProvider = this.aggregateByProvider(rows);
      out.push({
        date,
        promptTokens: byProvider.reduce((s, p) => s + p.promptTokens, 0),
        completionTokens: byProvider.reduce((s, p) => s + p.completionTokens, 0),
        totalTokens: byProvider.reduce((s, p) => s + p.totalTokens, 0),
        totalImages: byProvider.reduce((s, p) => s + p.imageCount, 0),
        cost: byProvider.reduce((s, p) => s + p.cost, 0),
        byProvider,
      });
    }
    return out;
  }

  /** Look up pricing for a model name, supporting trailing-wildcard prefix match. */
  private getModelPricing(modelName: string | undefined): ModelPricingEntry | undefined {
    const pricing = this.config.getAIConfig()?.modelPricing;
    if (!pricing || !modelName) return undefined;

    // Exact match first
    if (pricing[modelName]) return pricing[modelName];

    // Wildcard prefix match (e.g. "gemini-3.1-flash*" matches "gemini-3.1-flash-image")
    for (const [pattern, entry] of Object.entries(pricing)) {
      if (pattern.endsWith('*') && modelName.startsWith(pattern.slice(0, -1))) {
        return entry;
      }
    }
    return undefined;
  }

  /** USD for one call priced with `modelPricing`; 0 when the model has no price. */
  private priceUsage(usage: PricedUsage): number {
    const price = this.getModelPricing(usage.model);
    if (!price) return 0;
    if ('perImage' in price) {
      return usage.imageCount * price.perImage;
    }
    const uncachedPromptTokens = usage.promptTokens - usage.cachedPromptTokens;
    return (
      (uncachedPromptTokens * price.input +
        usage.cachedPromptTokens * (price.cachedInput ?? price.input) +
        usage.completionTokens * price.output) /
      1_000_000
    );
  }

  private aggregateByProvider(rows: TokenUsageRecord[]): ProviderUsageAgg[] {
    const map = new Map<string, ProviderUsageAgg>();
    for (const row of rows) {
      const key = `${row.provider}|${row.type}`;
      let agg = map.get(key);
      if (!agg) {
        agg = {
          provider: row.provider,
          type: row.type,
          calls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          imageCount: 0,
          cost: 0,
        };
        map.set(key, agg);
      }
      agg.calls += 1;
      agg.promptTokens += row.promptTokens;
      agg.completionTokens += row.completionTokens;
      agg.totalTokens += row.totalTokens;
      agg.imageCount += row.imageCount;
      agg.cost += this.priceUsage(row);
    }
    return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens || b.imageCount - a.imageCount);
  }
}

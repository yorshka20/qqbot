// Per-user token / image consumption tracking.
//
// One row is written per user-triggered LLM call (incl. subagent / tool-loop
// iterations) and per image-generation call. Recording is fire-and-forget: a
// persistence failure must never break reply generation. Aggregation happens at
// read time (modest volume; keeps the schema flexible and adapter-agnostic).

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
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
  completionTokens?: number;
  totalTokens?: number;
  imageCount?: number;
}

export interface ProviderUsageAgg {
  provider: string;
  type: 'llm' | 'image';
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  imageCount: number;
}

export interface UserUsageAgg {
  userId: string;
  nickname?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalImages: number;
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
  topUsers: UserUsageAgg[];
}

export interface DailyUsageAgg {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalImages: number;
  byProvider: ProviderUsageAgg[];
}

@injectable()
export class TokenUsageService {
  constructor(@inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager) {}

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
   * Record one usage event. Fire-and-forget — never throws into the caller and
   * never blocks the reply path. Skips no-op events (zero tokens AND zero images)
   * so failed/empty provider responses don't pollute the stats.
   */
  record(event: TokenUsageEvent): void {
    const promptTokens = event.promptTokens ?? 0;
    const completionTokens = event.completionTokens ?? 0;
    const totalTokens = event.totalTokens ?? promptTokens + completionTokens;
    const imageCount = event.imageCount ?? 0;
    if (totalTokens <= 0 && imageCount <= 0) {
      return;
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
      completionTokens,
      totalTokens,
      imageCount,
    };

    void this.databaseManager
      .getAdapter()
      .getModel('tokenUsage')
      .create(record)
      .catch((err) => logger.warn('[TokenUsageService] Failed to persist usage record:', err));
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
        byProvider,
      });
    }
    return out;
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
        };
        map.set(key, agg);
      }
      agg.calls += 1;
      agg.promptTokens += row.promptTokens;
      agg.completionTokens += row.completionTokens;
      agg.totalTokens += row.totalTokens;
      agg.imageCount += row.imageCount;
    }
    return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens || b.imageCount - a.imageCount);
  }
}

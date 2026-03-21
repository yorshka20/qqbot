/**
 * Moments backend: REST API (/api/moments) for WeChat moments data.
 *
 * Uses RetrievalService for all Qdrant operations (scroll, count, vector search).
 * Uses WeChatDatabase for analysis results (sentiment, entities).
 *
 * API contract:
 * - GET  /api/moments/stats                                  -> { stats: MomentsStats }
 * - GET  /api/moments/list?tag=&year=&type=&offset=&limit=   -> { moments: MomentItem[], total: number, nextOffset: string|null }
 * - GET  /api/moments/tags                                   -> { tags: TagCount[] }
 * - GET  /api/moments/timeline                               -> { timeline: TimelineEntry[] }
 * - GET  /api/moments/search?q=&limit=&minScore=             -> { moments: MomentItem[], query: string }
 * - GET  /api/moments/interest-evolution                     -> { heatmap, tags, months }
 * - GET  /api/moments/behavior                               -> { hourDistribution, dayOfWeekDistribution, monthlyFrequency, gapStats }
 * - GET  /api/moments/sentiment-trend                        -> { trend, overall, analyzedCount }
 * - GET  /api/moments/entities?type=&limit=                  -> { entities, byType, analyzedCount }
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { WechatDITokens } from '@/services/wechat/tokens';
import type { WeChatDatabase } from '@/services/wechat/WeChatDatabase';
import { logger } from '@/utils/logger';

const API_PREFIX = '/api/moments';
const COLLECTION = 'wechat_moments';

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export interface MomentItem {
  id: string | number;
  content: string;
  createTime: string;
  type: string;
  mediasCount: number;
  tags: string[];
  summary: string;
  imagePaths: string[];
  score?: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TimelineEntry {
  month: string; // "YYYY-MM"
  count: number;
}

export interface MomentsStats {
  total: number;
  tagged: number;
  untagged: number;
  timeRange: { earliest: string; latest: string } | null;
  topTags: TagCount[];
  monthlyCount: TimelineEntry[];
}

// Response types
export interface MomentsStatsResponse {
  stats: MomentsStats;
}
export interface MomentsListResponse {
  moments: MomentItem[];
  total: number;
  nextOffset: string | number | null;
}
export interface MomentsTagsResponse {
  tags: TagCount[];
}
export interface MomentsTimelineResponse {
  timeline: TimelineEntry[];
}
export interface MomentsSearchResponse {
  moments: MomentItem[];
  query: string;
}

// ── Analysis response types ──

export interface InterestEvolutionResponse {
  heatmap: Array<{ tag: string; month: string; count: number }>;
  tags: string[];
  months: string[];
}

export interface BehaviorResponse {
  hourDistribution: Array<{ hour: number; count: number }>;
  dayOfWeekDistribution: Array<{ day: number; label: string; count: number }>;
  monthlyFrequency: Array<{ month: string; count: number; avgGapDays: number }>;
  gapStats: { avgDays: number; medianDays: number; maxDays: number; minDays: number };
}

export interface SentimentTrendResponse {
  trend: Array<{
    month: string;
    avgScore: number;
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
    count: number;
  }>;
  overall: { avgScore: number; positive: number; negative: number; neutral: number; mixed: number; total: number };
  analyzedCount: number;
}

export interface EntitiesResponse {
  entities: Array<{ name: string; type: string; count: number }>;
  byType: Record<string, Array<{ name: string; count: number }>>;
  analyzedCount: number;
}

interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse<ErrorResponse>({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Payload → MomentItem
// ---------------------------------------------------------------------------

function payloadToMomentItem(id: string | number, payload: Record<string, unknown>, score?: number): MomentItem {
  return {
    id,
    content: (payload.content as string) || '',
    createTime: (payload.create_time as string) || '',
    type: (payload.type as string) || '',
    mediasCount: (payload.medias_count as number) || 0,
    tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
    summary: (payload.summary as string) || '',
    imagePaths: Array.isArray(payload.image_paths) ? (payload.image_paths as string[]) : [],
    ...(score != null && { score }),
  };
}

// ---------------------------------------------------------------------------
// MomentsBackend
// ---------------------------------------------------------------------------

export class MomentsBackend {
  private retrieval: RetrievalService | null = null;
  private db: WeChatDatabase | null = null;

  private getRetrieval(): RetrievalService | null {
    if (this.retrieval) return this.retrieval;
    try {
      const container = getContainer();
      this.retrieval = container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);
      if (!this.retrieval.isRAGEnabled()) {
        this.retrieval = null;
      }
      return this.retrieval;
    } catch {
      logger.debug('[MomentsBackend] RetrievalService not available');
      return null;
    }
  }

  private getDB(): WeChatDatabase | null {
    if (this.db) return this.db;
    try {
      const container = getContainer();
      this.db = container.resolve<WeChatDatabase>(WechatDITokens.WECHAT_DB);
      return this.db;
    } catch {
      logger.debug('[MomentsBackend] WeChatDatabase not available');
      return null;
    }
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    const retrieval = this.getRetrieval();
    if (!retrieval) return errorResponse('RAG not enabled', 503);

    const subPath = pathname.slice(API_PREFIX.length);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    if (subPath === '/stats') return this.handleStats(retrieval);
    if (subPath === '/list') return this.handleList(retrieval, new URL(req.url));
    if (subPath === '/tags') return this.handleTags(retrieval);
    if (subPath === '/timeline') return this.handleTimeline(retrieval);
    if (subPath === '/search') return this.handleSearch(retrieval, new URL(req.url));
    if (subPath === '/interest-evolution') return this.handleInterestEvolution(retrieval);
    if (subPath === '/behavior') return this.handleBehavior(retrieval);
    if (subPath === '/sentiment-trend') return this.handleSentimentTrend();
    if (subPath === '/entities') return this.handleEntities(new URL(req.url));

    return errorResponse('Not found', 404);
  }

  // ──────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────

  private async handleStats(retrieval: RetrievalService): Promise<Response> {
    try {
      const totalCount = await retrieval.countPoints(COLLECTION);
      const taggedCount = await retrieval.countPoints(COLLECTION, {
        must_not: [{ is_empty: { key: 'tags' } }],
      });

      // Scroll all to compute tag distribution + timeline
      const allPoints = await this.collectAll(retrieval, ['create_time', 'tags']);

      // Time range
      const times = allPoints
        .map((p) => p.payload.create_time as string)
        .filter(Boolean)
        .sort();
      const timeRange = times.length > 0 ? { earliest: times[0], latest: times[times.length - 1] } : null;

      // Tag distribution
      const tagCounts = new Map<string, number>();
      for (const p of allPoints) {
        const tags = p.payload.tags as string[] | undefined;
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
      }
      const topTags = [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30);

      // Monthly count
      const monthCounts = new Map<string, number>();
      for (const p of allPoints) {
        const ct = p.payload.create_time as string;
        if (ct) {
          const month = ct.slice(0, 7);
          monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
        }
      }
      const monthlyCount = [...monthCounts.entries()]
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month));

      return jsonResponse<MomentsStatsResponse>({
        stats: {
          total: totalCount,
          tagged: taggedCount,
          untagged: totalCount - taggedCount,
          timeRange,
          topTags,
          monthlyCount,
        },
      });
    } catch (err) {
      logger.error('[MomentsBackend] stats error:', err);
      return errorResponse('Failed to get moments stats', 500);
    }
  }

  private async handleList(retrieval: RetrievalService, url: URL): Promise<Response> {
    try {
      const tag = url.searchParams.get('tag') || '';
      const date = url.searchParams.get('date') || ''; // "YYYY-MM-DD"
      const month = url.searchParams.get('month') || ''; // "YYYY-MM"
      const year = url.searchParams.get('year') || ''; // "YYYY"
      const type = url.searchParams.get('type') || '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

      // Build Qdrant filter using keyword match on indexed fields
      const must: unknown[] = [];
      if (tag) must.push({ key: 'tags', match: { value: tag } });
      if (type) must.push({ key: 'type', match: { value: type } });
      if (date) must.push({ key: 'create_date', match: { value: date } });
      else if (month) must.push({ key: 'create_month', match: { value: month } });
      else if (year) must.push({ key: 'create_year', match: { value: year } });
      const filter = must.length > 0 ? { must } : undefined;

      const allPoints: Array<{ id: string | number; payload: Record<string, unknown> }> = [];
      for await (const page of retrieval.scrollAll(COLLECTION, { limit, filter })) {
        allPoints.push(...page);
        break; // One page for list view
      }

      const moments = allPoints.map((p) => payloadToMomentItem(p.id, p.payload));

      return jsonResponse<MomentsListResponse>({
        moments,
        total: moments.length,
        nextOffset: allPoints.length >= limit ? (allPoints[allPoints.length - 1]?.id ?? null) : null,
      });
    } catch (err) {
      logger.error('[MomentsBackend] list error:', err);
      return errorResponse('Failed to list moments', 500);
    }
  }

  private async handleTags(retrieval: RetrievalService): Promise<Response> {
    try {
      const allPoints = await this.collectAll(retrieval, ['tags']);
      const tagCounts = new Map<string, number>();
      for (const p of allPoints) {
        const tags = p.payload.tags as string[] | undefined;
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
      }
      const tags = [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);

      return jsonResponse<MomentsTagsResponse>({ tags });
    } catch (err) {
      logger.error('[MomentsBackend] tags error:', err);
      return errorResponse('Failed to get tags', 500);
    }
  }

  private async handleTimeline(retrieval: RetrievalService): Promise<Response> {
    try {
      const allPoints = await this.collectAll(retrieval, ['create_time']);
      const monthCounts = new Map<string, number>();
      for (const p of allPoints) {
        const ct = p.payload.create_time as string;
        if (ct) {
          const month = ct.slice(0, 7);
          monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
        }
      }
      const timeline = [...monthCounts.entries()]
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month));

      return jsonResponse<MomentsTimelineResponse>({ timeline });
    } catch (err) {
      logger.error('[MomentsBackend] timeline error:', err);
      return errorResponse('Failed to get timeline', 500);
    }
  }

  private async handleSearch(retrieval: RetrievalService, url: URL): Promise<Response> {
    try {
      const query = url.searchParams.get('q')?.trim() || '';
      if (!query) return errorResponse('Missing query parameter: q', 400);

      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
      const minScore = Number(url.searchParams.get('minScore') ?? 0.35);

      const hits = await retrieval.vectorSearch(COLLECTION, query, { limit, minScore });

      // Sort by create_time ascending
      hits.sort((a, b) => {
        const ta = (a.payload?.create_time as string) || '';
        const tb = (b.payload?.create_time as string) || '';
        return ta.localeCompare(tb);
      });

      const moments = hits.map((h) => payloadToMomentItem(h.id, h.payload, h.score));

      return jsonResponse<MomentsSearchResponse>({ moments, query });
    } catch (err) {
      logger.error('[MomentsBackend] search error:', err);
      return errorResponse('Failed to search moments', 500);
    }
  }

  // ──────────────────────────────────────────────────
  // Analysis handlers
  // ──────────────────────────────────────────────────

  /** Feature 1: Interest evolution — tag × month heatmap */
  private async handleInterestEvolution(retrieval: RetrievalService): Promise<Response> {
    try {
      const allPoints = await this.collectAll(retrieval, ['tags', 'create_time']);

      // Cross-tabulate tag × month
      const tagMonthMap = new Map<string, Map<string, number>>();
      const allMonths = new Set<string>();
      const allTags = new Set<string>();

      for (const p of allPoints) {
        const tags = p.payload.tags as string[] | undefined;
        const ct = p.payload.create_time as string;
        if (!Array.isArray(tags) || !ct) continue;
        const month = ct.slice(0, 7);
        allMonths.add(month);

        for (const tag of tags) {
          allTags.add(tag);
          let monthMap = tagMonthMap.get(tag);
          if (!monthMap) {
            monthMap = new Map();
            tagMonthMap.set(tag, monthMap);
          }
          monthMap.set(month, (monthMap.get(month) ?? 0) + 1);
        }
      }

      const heatmap: Array<{ tag: string; month: string; count: number }> = [];
      for (const [tag, monthMap] of tagMonthMap) {
        for (const [month, count] of monthMap) {
          heatmap.push({ tag, month, count });
        }
      }

      const months = [...allMonths].sort();
      const tags = [...allTags].sort((a, b) => {
        // Sort by total count descending
        const aTotal = tagMonthMap.get(a)?.size ?? 0;
        const bTotal = tagMonthMap.get(b)?.size ?? 0;
        return bTotal - aTotal;
      });

      return jsonResponse<InterestEvolutionResponse>({ heatmap, tags, months });
    } catch (err) {
      logger.error('[MomentsBackend] interest-evolution error:', err);
      return errorResponse('Failed to compute interest evolution', 500);
    }
  }

  /** Feature 7: Posting behavior patterns */
  private async handleBehavior(retrieval: RetrievalService): Promise<Response> {
    try {
      const allPoints = await this.collectAll(retrieval, ['create_time']);

      const DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const hourCounts = new Array(24).fill(0);
      const dayCounts = new Array(7).fill(0);
      const monthMap = new Map<string, number[]>(); // month -> array of timestamps
      const allTimestamps: number[] = [];

      for (const p of allPoints) {
        const ct = p.payload.create_time as string;
        if (!ct) continue;
        const d = new Date(ct.replace(' ', 'T'));
        if (Number.isNaN(d.getTime())) continue;

        hourCounts[d.getHours()]++;
        dayCounts[d.getDay()]++;

        const ts = d.getTime();
        allTimestamps.push(ts);

        const month = ct.slice(0, 7);
        if (!monthMap.has(month)) monthMap.set(month, []);
        monthMap.get(month)!.push(ts);
      }

      // Hour distribution
      const hourDistribution = hourCounts.map((count, hour) => ({ hour, count }));

      // Day of week distribution
      const dayOfWeekDistribution = dayCounts.map((count, day) => ({ day, label: DAY_LABELS[day], count }));

      // Monthly frequency with average gap
      const monthlyFrequency: Array<{ month: string; count: number; avgGapDays: number }> = [];
      for (const [month, timestamps] of [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        timestamps.sort((a, b) => a - b);
        let avgGapDays = 0;
        if (timestamps.length > 1) {
          let totalGap = 0;
          for (let i = 1; i < timestamps.length; i++) {
            totalGap += timestamps[i] - timestamps[i - 1];
          }
          avgGapDays = totalGap / (timestamps.length - 1) / (1000 * 60 * 60 * 24);
        }
        monthlyFrequency.push({ month, count: timestamps.length, avgGapDays: Math.round(avgGapDays * 10) / 10 });
      }

      // Gap stats (overall)
      allTimestamps.sort((a, b) => a - b);
      const gaps: number[] = [];
      for (let i = 1; i < allTimestamps.length; i++) {
        gaps.push((allTimestamps[i] - allTimestamps[i - 1]) / (1000 * 60 * 60 * 24));
      }

      let gapStats = { avgDays: 0, medianDays: 0, maxDays: 0, minDays: 0 };
      if (gaps.length > 0) {
        gaps.sort((a, b) => a - b);
        const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        const median = gaps[Math.floor(gaps.length / 2)];
        gapStats = {
          avgDays: Math.round(avg * 10) / 10,
          medianDays: Math.round(median * 10) / 10,
          maxDays: Math.round(gaps[gaps.length - 1] * 10) / 10,
          minDays: Math.round(gaps[0] * 10) / 10,
        };
      }

      return jsonResponse<BehaviorResponse>({ hourDistribution, dayOfWeekDistribution, monthlyFrequency, gapStats });
    } catch (err) {
      logger.error('[MomentsBackend] behavior error:', err);
      return errorResponse('Failed to compute behavior patterns', 500);
    }
  }

  /** Feature 4: Sentiment trend (from SQLite) */
  private handleSentimentTrend(): Response {
    try {
      const db = this.getDB();
      if (!db) return errorResponse('WeChatDatabase not available', 503);

      const trend = db.getMomentsSentimentTrend();
      const overall = db.getMomentsSentimentOverall();
      const analyzedCount = db.getMomentsSentimentCount();

      return jsonResponse<SentimentTrendResponse>({ trend, overall, analyzedCount });
    } catch (err) {
      logger.error('[MomentsBackend] sentiment-trend error:', err);
      return errorResponse('Failed to get sentiment trend', 500);
    }
  }

  /** Feature 6: Entity extraction results (from SQLite) */
  private handleEntities(url: URL): Response {
    try {
      const db = this.getDB();
      if (!db) return errorResponse('WeChatDatabase not available', 503);

      const type = url.searchParams.get('type') || undefined;
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

      const entities = db.getMomentsTopEntities({ type, limit });
      const byType = db.getMomentsEntitiesByType();
      const analyzedCount = db.getMomentsEntityMomentCount();

      return jsonResponse<EntitiesResponse>({ entities, byType, analyzedCount });
    } catch (err) {
      logger.error('[MomentsBackend] entities error:', err);
      return errorResponse('Failed to get entities', 500);
    }
  }

  // ──────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────

  private async collectAll(
    retrieval: RetrievalService,
    includePayload: string[],
  ): Promise<Array<{ id: string | number; payload: Record<string, unknown> }>> {
    const all: Array<{ id: string | number; payload: Record<string, unknown> }> = [];
    for await (const page of retrieval.scrollAll(COLLECTION, {
      limit: 500,
      withPayload: { include: includePayload } as unknown as boolean,
    })) {
      all.push(...page);
    }
    return all;
  }
}

/**
 * Moments backend: REST API (/api/moments) for WeChat moments data.
 *
 * Uses RetrievalService for all Qdrant operations (scroll, count, vector search).
 *
 * API contract:
 * - GET  /api/moments/stats                                  -> { stats: MomentsStats }
 * - GET  /api/moments/list?tag=&year=&type=&offset=&limit=   -> { moments: MomentItem[], total: number, nextOffset: string|null }
 * - GET  /api/moments/tags                                   -> { tags: TagCount[] }
 * - GET  /api/moments/timeline                               -> { timeline: TimelineEntry[] }
 * - GET  /api/moments/search?q=&limit=&minScore=             -> { moments: MomentItem[], query: string }
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
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
    ...(score != null && { score }),
  };
}

// ---------------------------------------------------------------------------
// MomentsBackend
// ---------------------------------------------------------------------------

export class MomentsBackend {
  private retrieval: RetrievalService | null = null;

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
      const year = url.searchParams.get('year') || '';
      const type = url.searchParams.get('type') || '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

      // Build filter
      const must: unknown[] = [];
      if (tag) must.push({ key: 'tags', match: { value: tag } });
      if (type) must.push({ key: 'type', match: { value: type } });
      const filter = must.length > 0 ? { must } : undefined;

      // Use scrollAll with one page
      const allPoints: Array<{ id: string | number; payload: Record<string, unknown> }> = [];
      for await (const page of retrieval.scrollAll(COLLECTION, { limit, filter })) {
        allPoints.push(...page);
        break; // Only one page for list view
      }

      let points = allPoints;

      // Client-side year filter
      if (year) {
        points = points.filter((p) => {
          const ct = p.payload.create_time as string;
          return ct?.startsWith(year);
        });
      }

      const moments = points.map((p) => payloadToMomentItem(p.id, p.payload));

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

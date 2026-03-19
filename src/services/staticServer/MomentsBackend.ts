/**
 * Moments backend: REST API (/api/moments) for WeChat moments data from Qdrant.
 *
 * API contract:
 * - GET  /api/moments/stats                         -> { stats: MomentsStats }
 * - GET  /api/moments/list?tag=&year=&type=&offset=&limit= -> { moments: MomentItem[], total: number, nextOffset: string|null }
 * - GET  /api/moments/tags                          -> { tags: TagCount[] }
 * - GET  /api/moments/timeline                      -> { timeline: TimelineEntry[] }
 */

import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
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
// Qdrant helpers
// ---------------------------------------------------------------------------

interface QdrantPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

interface QdrantScrollResult {
  result: {
    points: QdrantPoint[];
    next_page_offset: string | number | null;
  };
}

interface QdrantCountResult {
  result: { count: number };
}

// ---------------------------------------------------------------------------
// MomentsBackend
// ---------------------------------------------------------------------------

export class MomentsBackend {
  private qdrantUrl: string | null = null;

  private getQdrantUrl(): string | null {
    if (this.qdrantUrl) return this.qdrantUrl;
    try {
      const container = getContainer();
      const config = container.resolve<Config>(DITokens.CONFIG);
      const rag = config.getRAGConfig();
      if (rag?.enabled && rag.qdrant?.url) {
        this.qdrantUrl = rag.qdrant.url;
        return this.qdrantUrl;
      }
    } catch {
      logger.debug('[MomentsBackend] Config not available');
    }
    return null;
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    const qdrantUrl = this.getQdrantUrl();
    if (!qdrantUrl) return errorResponse('RAG/Qdrant not configured', 503);

    const subPath = pathname.slice(API_PREFIX.length);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    if (subPath === '/stats') return this.handleStats(qdrantUrl);
    if (subPath === '/list') return this.handleList(qdrantUrl, new URL(req.url));
    if (subPath === '/tags') return this.handleTags(qdrantUrl);
    if (subPath === '/timeline') return this.handleTimeline(qdrantUrl);

    return errorResponse('Not found', 404);
  }

  // ──────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────

  private async handleStats(qdrantUrl: string): Promise<Response> {
    try {
      // Get total count
      const totalCount = await this.countPoints(qdrantUrl);

      // Get tagged count
      const taggedCount = await this.countPoints(qdrantUrl, {
        must_not: [{ is_empty: { key: 'tags' } }],
      });

      // Scroll all to compute stats (tags + timeline)
      const allPoints = await this.scrollAll(qdrantUrl, ['create_time', 'tags']);

      // Time range
      const times = allPoints
        .map((p) => p.payload.create_time as string)
        .filter(Boolean)
        .sort();
      const timeRange =
        times.length > 0 ? { earliest: times[0], latest: times[times.length - 1] } : null;

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
          const month = ct.slice(0, 7); // "YYYY-MM"
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

  private async handleList(qdrantUrl: string, url: URL): Promise<Response> {
    try {
      const tag = url.searchParams.get('tag') || '';
      const year = url.searchParams.get('year') || '';
      const type = url.searchParams.get('type') || '';
      const offset = url.searchParams.get('offset') || undefined;
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

      // Build filter
      const must: unknown[] = [];
      if (tag) {
        must.push({ key: 'tags', match: { value: tag } });
      }
      if (type) {
        must.push({ key: 'type', match: { value: type } });
      }

      const filter = must.length > 0 ? { must } : undefined;

      const body: Record<string, unknown> = {
        limit,
        with_payload: true,
        with_vector: false,
        filter,
      };
      if (offset) {
        body.offset = offset;
      }

      const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`Qdrant scroll failed: ${res.status}`);

      const data = (await res.json()) as QdrantScrollResult;
      let points = data.result.points;

      // Client-side year filter (create_time is a string "YYYY-MM-DD HH:mm:ss")
      if (year) {
        points = points.filter((p) => {
          const ct = p.payload.create_time as string;
          return ct?.startsWith(year);
        });
      }

      const moments: MomentItem[] = points.map((p) => ({
        id: p.id,
        content: (p.payload.content as string) || '',
        createTime: (p.payload.create_time as string) || '',
        type: (p.payload.type as string) || '',
        mediasCount: (p.payload.medias_count as number) || 0,
        tags: Array.isArray(p.payload.tags) ? (p.payload.tags as string[]) : [],
        summary: (p.payload.summary as string) || '',
      }));

      return jsonResponse<MomentsListResponse>({
        moments,
        total: moments.length,
        nextOffset: data.result.next_page_offset,
      });
    } catch (err) {
      logger.error('[MomentsBackend] list error:', err);
      return errorResponse('Failed to list moments', 500);
    }
  }

  private async handleTags(qdrantUrl: string): Promise<Response> {
    try {
      const allPoints = await this.scrollAll(qdrantUrl, ['tags']);
      const tagCounts = new Map<string, number>();
      for (const p of allPoints) {
        const tags = p.payload.tags as string[] | undefined;
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
      }
      const tags = [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);

      return jsonResponse<MomentsTagsResponse>({ tags });
    } catch (err) {
      logger.error('[MomentsBackend] tags error:', err);
      return errorResponse('Failed to get tags', 500);
    }
  }

  private async handleTimeline(qdrantUrl: string): Promise<Response> {
    try {
      const allPoints = await this.scrollAll(qdrantUrl, ['create_time']);
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

  // ──────────────────────────────────────────────────
  // Qdrant utilities
  // ──────────────────────────────────────────────────

  private async countPoints(
    qdrantUrl: string,
    filter?: Record<string, unknown>,
  ): Promise<number> {
    const body: Record<string, unknown> = { exact: true };
    if (filter) body.filter = filter;

    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant count failed: ${res.status}`);
    const data = (await res.json()) as QdrantCountResult;
    return data.result.count;
  }

  private async scrollAll(
    qdrantUrl: string,
    includePayload: string[],
  ): Promise<QdrantPoint[]> {
    const allPoints: QdrantPoint[] = [];
    let offset: string | number | null = null;

    while (true) {
      const body: Record<string, unknown> = {
        limit: 500,
        with_payload: { include: includePayload },
        with_vector: false,
      };
      if (offset != null) body.offset = offset;

      const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Qdrant scroll failed: ${res.status}`);

      const data = (await res.json()) as QdrantScrollResult;
      allPoints.push(...data.result.points);
      offset = data.result.next_page_offset;

      if (offset == null || data.result.points.length === 0) break;
    }

    return allPoints;
  }
}

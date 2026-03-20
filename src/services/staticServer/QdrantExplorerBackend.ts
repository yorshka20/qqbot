/**
 * Qdrant Explorer backend: REST API (/api/qdrant) for browsing and searching Qdrant collections.
 *
 * API contract:
 * - GET  /api/qdrant/collections                                      -> { collections: CollectionInfo[] }
 * - GET  /api/qdrant/collection/:name                                 -> { info: CollectionDetail }
 * - GET  /api/qdrant/search?collection=&q=&limit=&minScore=           -> { results: SearchHit[], query: string }
 * - GET  /api/qdrant/scroll?collection=&limit=&offset=                -> { points: PointItem[], nextOffset: string|number|null }
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';

const API_PREFIX = '/api/qdrant';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// QdrantExplorerBackend
// ---------------------------------------------------------------------------

export class QdrantExplorerBackend {
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
      logger.debug('[QdrantExplorerBackend] RetrievalService not available');
      return null;
    }
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    const retrieval = this.getRetrieval();
    if (!retrieval) return errorResponse('RAG not enabled', 503);

    const subPath = pathname.slice(API_PREFIX.length);
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    if (subPath === '/collections') return this.handleCollections(retrieval);
    if (subPath === '/search') return this.handleSearch(retrieval, new URL(req.url));
    if (subPath === '/scroll') return this.handleScroll(retrieval, new URL(req.url));

    // /collection/:name
    const collectionMatch = subPath.match(/^\/collection\/(.+)$/);
    if (collectionMatch?.[1]) {
      return this.handleCollectionInfo(retrieval, decodeURIComponent(collectionMatch[1]));
    }

    return errorResponse('Not found', 404);
  }

  // ──────────────────────────────────────────────────
  // Handlers
  // ──────────────────────────────────────────────────

  private async handleCollections(retrieval: RetrievalService): Promise<Response> {
    try {
      const collections = await retrieval.listCollections();
      // Fetch point counts in parallel
      const infos = await Promise.all(
        collections.map(async (c) => {
          try {
            const info = await retrieval.getCollectionInfo(c.name);
            return {
              name: c.name,
              pointsCount: info.pointsCount,
              vectorSize: info.vectorSize,
              distance: info.distance,
            };
          } catch {
            return { name: c.name, pointsCount: 0, vectorSize: 0, distance: 'Unknown' };
          }
        }),
      );
      return jsonResponse({ collections: infos });
    } catch (err) {
      logger.error('[QdrantExplorerBackend] collections error:', err);
      return errorResponse('Failed to list collections', 500);
    }
  }

  private async handleCollectionInfo(retrieval: RetrievalService, name: string): Promise<Response> {
    try {
      const info = await retrieval.getCollectionInfo(name);
      return jsonResponse({ info: { name, ...info } });
    } catch (err) {
      logger.error('[QdrantExplorerBackend] collection info error:', err);
      return errorResponse('Failed to get collection info', 500);
    }
  }

  private async handleSearch(retrieval: RetrievalService, url: URL): Promise<Response> {
    try {
      const collection = url.searchParams.get('collection')?.trim();
      const query = url.searchParams.get('q')?.trim();
      if (!collection) return errorResponse('Missing parameter: collection', 400);
      if (!query) return errorResponse('Missing parameter: q', 400);

      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
      const minScore = Number(url.searchParams.get('minScore') ?? 0.3);

      const hits = await retrieval.vectorSearch(collection, query, { limit, minScore });

      const results = hits.map((h) => ({
        id: h.id,
        score: h.score,
        payload: h.payload,
      }));

      return jsonResponse({ results, query, collection });
    } catch (err) {
      logger.error('[QdrantExplorerBackend] search error:', err);
      return errorResponse('Failed to search', 500);
    }
  }

  private async handleScroll(retrieval: RetrievalService, url: URL): Promise<Response> {
    try {
      const collection = url.searchParams.get('collection')?.trim();
      if (!collection) return errorResponse('Missing parameter: collection', 400);

      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

      const points: Array<{ id: string | number; payload: Record<string, unknown> }> = [];
      for await (const page of retrieval.scrollAll(collection, { limit })) {
        points.push(...page);
        break; // Only one page
      }

      return jsonResponse({
        points: points.map((p) => ({ id: p.id, payload: p.payload })),
        total: points.length,
      });
    } catch (err) {
      logger.error('[QdrantExplorerBackend] scroll error:', err);
      return errorResponse('Failed to scroll collection', 500);
    }
  }
}

// Qdrant HTTP API client
// Qdrant point id must be ExtendedPointId: uint64 integer OR string in UUID format.
// Arbitrary strings (e.g. message id "milky_1772197146_xjm0xvdmf") cause HTTP 400.

import { validate as uuidValidate, v5 as uuidv5 } from 'uuid';
import { HttpClient } from '@/api/http/HttpClient';
import type { QdrantConfig } from '@/core/config/types/rag';
import { logger } from '@/utils/logger';

/** Use RFC DNS namespace for deterministic UUID v5 from RAG document ids (e.g. message id). Same id => same point id. */
const RAG_POINT_ID_NAMESPACE = uuidv5.DNS;

/**
 * Convert point id to Qdrant-compatible format.
 * Qdrant accepts only: uint64 number, or string in UUID format.
 * Other strings are converted to deterministic UUID v5.
 */
function toQdrantPointId(id: string | number): string | number {
  if (typeof id === 'number' && Number.isInteger(id) && id >= 0) {
    return id;
  }
  if (typeof id === 'string' && uuidValidate(id)) {
    return id;
  }
  return uuidv5(String(id), RAG_POINT_ID_NAMESPACE);
}

interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

interface QdrantUpsertRequest {
  points: QdrantPoint[];
}

interface QdrantSearchRequest {
  vector: number[];
  limit?: number;
  with_payload?: boolean;
  filter?: Record<string, unknown>;
}

interface QdrantSearchResultItem {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

interface QdrantSearchResponse {
  result?: QdrantSearchResultItem[];
}

export class QdrantClient {
  private httpClient: HttpClient;
  private baseUrl: string;

  /**
   * Derive collection name for conversation history RAG: {groupId}_conversation_history (group)
   * or user_{userId}_conversation_history (private). Used by RAGPersistenceSystem and ReplyGenerationService.
   */
  static getConversationHistoryCollectionName(
    sessionId: string,
    sessionType: string,
    groupId?: number,
    userId?: number,
  ): string {
    if (sessionType === 'group' && groupId != null) {
      return `${groupId}_conversation_history`;
    }
    if (userId != null) {
      return `user_${userId}_conversation_history`;
    }
    if (sessionId.startsWith('group:')) {
      return `${sessionId.replace('group:', '')}_conversation_history`;
    }
    if (sessionId.startsWith('user:')) {
      return `user_${sessionId.replace('user:', '')}_conversation_history`;
    }
    return `session_${sessionId.replace(/[^a-zA-Z0-9_]/g, '_')}_conversation_history`;
  }

  constructor(config: QdrantConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['api-key'] = config.apiKey;
    }
    this.httpClient = new HttpClient({
      baseURL: this.baseUrl,
      defaultHeaders: headers,
      defaultTimeout: config.timeout ?? 30000,
    });
  }

  /**
   * Ensure collection exists, create if not
   */
  async ensureCollection(
    name: string,
    options: { vectorSize: number; distance?: string } = { vectorSize: 2560 },
  ): Promise<void> {
    const distance = options.distance ?? 'Cosine';
    try {
      await this.httpClient.put(`/collections/${name}`, {
        vectors: {
          size: options.vectorSize,
          distance,
        },
      });
      logger.debug(`[QdrantClient] Collection ${name} created or ensured`);
    } catch (error) {
      // If collection already exists, Qdrant may return error - check and ignore
      const err = error instanceof Error ? error : new Error(String(error));
      const msg = err.message.toLowerCase();
      if (msg.includes('already exists') || msg.includes('409')) {
        logger.debug(`[QdrantClient] Collection ${name} already exists`);
        return;
      }
      throw err;
    }
  }

  /**
   * Upsert points into collection
   */
  async upsertPoints(
    collection: string,
    points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }>,
  ): Promise<void> {
    if (points.length === 0) return;

    const body: QdrantUpsertRequest = {
      points: points.map((p) => ({
        id: toQdrantPointId(p.id),
        vector: p.vector,
        payload: p.payload,
      })),
    };

    await this.httpClient.put(`/collections/${collection}/points`, body);
    logger.debug(`[QdrantClient] Upserted ${points.length} points to ${collection}`);
  }

  /**
   * Search for similar vectors
   */
  async search(
    collection: string,
    vector: number[],
    options: { limit?: number; withPayload?: boolean; filter?: Record<string, unknown> } = {},
  ): Promise<Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>> {
    const body: QdrantSearchRequest = {
      vector,
      limit: options.limit ?? 5,
      with_payload: options.withPayload ?? true,
      ...(options.filter && { filter: options.filter }),
    };

    const response = await this.httpClient.post<QdrantSearchResponse>(`/collections/${collection}/points/search`, body);

    const result = response.result ?? [];
    return result.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload,
    }));
  }

  /**
   * Scroll points by filter (no vector search, just payload filtering).
   * Returns all matching points up to the limit.
   */
  async scrollPoints(
    collection: string,
    filter: Record<string, unknown>,
    options: { limit?: number; withPayload?: boolean } = {},
  ): Promise<Array<{ id: string | number; payload?: Record<string, unknown> }>> {
    const body = {
      filter,
      limit: options.limit ?? 100,
      with_payload: options.withPayload ?? true,
    };

    const response = await this.httpClient.post<{
      result?: { points?: Array<{ id: string | number; payload?: Record<string, unknown> }> };
    }>(`/collections/${collection}/points/scroll`, body);

    return response.result?.points ?? [];
  }

  /**
   * Scroll through ALL points in a collection, handling pagination automatically.
   * Yields pages of points via async generator.
   */
  async *scrollAll(
    collection: string,
    options: { limit?: number; withPayload?: boolean; filter?: Record<string, unknown> } = {},
  ): AsyncGenerator<Array<{ id: string | number; payload?: Record<string, unknown> }>> {
    const pageSize = options.limit ?? 100;
    let offset: string | number | null = null;

    while (true) {
      const body: Record<string, unknown> = {
        limit: pageSize,
        with_payload: options.withPayload ?? true,
      };
      if (options.filter) body.filter = options.filter;
      if (offset !== null) body.offset = offset;

      const response = await this.httpClient.post<{
        result?: {
          points?: Array<{ id: string | number; payload?: Record<string, unknown> }>;
          next_page_offset?: string | number | null;
        };
      }>(`/collections/${collection}/points/scroll`, body);

      const points = response.result?.points ?? [];
      if (points.length === 0) break;

      yield points;

      const nextOffset = response.result?.next_page_offset;
      if (nextOffset == null) break;
      offset = nextOffset;
    }
  }

  /**
   * Delete points by filter.
   * Uses POST /collections/{name}/points/delete with filter body.
   */
  async deleteByFilter(collection: string, filter: Record<string, unknown>): Promise<void> {
    await this.httpClient.post(`/collections/${collection}/points/delete`, { filter });
    logger.debug(`[QdrantClient] Deleted points by filter from ${collection}`);
  }

  /**
   * Count points in a collection, optionally with a filter.
   */
  async countPoints(collection: string, filter?: Record<string, unknown>): Promise<number> {
    const body: Record<string, unknown> = { exact: true };
    if (filter) body.filter = filter;

    const response = await this.httpClient.post<{ result?: { count?: number } }>(
      `/collections/${collection}/points/count`,
      body,
    );
    return response.result?.count ?? 0;
  }

  /**
   * List all collections in the Qdrant instance.
   */
  async listCollections(): Promise<Array<{ name: string }>> {
    const response = await this.httpClient.get<{
      result?: { collections?: Array<{ name: string }> };
    }>('/collections');
    return response.result?.collections ?? [];
  }

  /**
   * Get collection info (point count, vector config, etc.).
   */
  async getCollectionInfo(
    collection: string,
  ): Promise<{ pointsCount: number; vectorSize: number; distance: string }> {
    const response = await this.httpClient.get<{
      result?: {
        points_count?: number;
        vectors_count?: number;
        config?: {
          params?: {
            vectors?: { size?: number; distance?: string };
          };
        };
      };
    }>(`/collections/${collection}`);
    const r = response.result;
    return {
      pointsCount: r?.points_count ?? 0,
      vectorSize: r?.config?.params?.vectors?.size ?? 0,
      distance: r?.config?.params?.vectors?.distance ?? 'Unknown',
    };
  }

  /**
   * Delete points by IDs.
   */
  async deleteByIds(collection: string, ids: Array<string | number>): Promise<void> {
    if (ids.length === 0) return;
    await this.httpClient.post(`/collections/${collection}/points/delete`, {
      points: ids,
    });
    logger.debug(`[QdrantClient] Deleted ${ids.length} points by ID from ${collection}`);
  }
}

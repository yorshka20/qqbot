// Qdrant HTTP API client

import { HttpClient } from '@/api/http/HttpClient';
import type { QdrantConfig } from '@/core/config/rag';
import { logger } from '@/utils/logger';

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
        id: p.id,
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
}

// Embedding client for an OpenAI-compatible POST {url}/embeddings endpoint (SiliconFlow).

import { HttpClient, HttpClientError } from '@/api/http/HttpClient';
import type { EmbeddingConfig } from '@/core/config/types/rag';
import { logger } from '@/utils/logger';

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * SiliconFlow answers bursts with 429 and short overloads with 502/503; both clear within
 * seconds. The backoff doubles from this base on each attempt.
 */
const MAX_TRANSIENT_RETRIES = 5;
const RETRY_BASE_MS = 400;

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
}

function normalizeL2(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof HttpClientError) || error.status === undefined) {
    return false;
  }
  return error.status === 429 || error.status >= 500;
}

export class EmbeddingClient {
  private readonly httpClient: HttpClient;
  private readonly batchSize: number;
  /** Stamped on every point this client embeds, so a provider switch can find the points it has not reached. */
  readonly model: string;

  constructor(config: EmbeddingConfig) {
    this.model = config.model;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.httpClient = new HttpClient({
      baseURL: config.url.replace(/\/$/, ''),
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      defaultTimeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
    });
  }

  /** Embed texts in input order; returns L2-normalized vectors. */
  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      vectors.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize))));
    }
    return vectors;
  }

  private async embedBatch(input: string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.httpClient.post<EmbeddingResponse>('/embeddings', { model: this.model, input });
        return this.orderedVectors(response, input.length);
      } catch (error) {
        if (!isTransient(error) || attempt >= MAX_TRANSIENT_RETRIES) {
          throw error;
        }
        const delay = RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 200);
        logger.debug(`[EmbeddingClient] transient ${(error as HttpClientError).status}, retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private orderedVectors(response: EmbeddingResponse, expected: number): number[][] {
    const data = response.data ?? [];
    if (data.length !== expected) {
      throw new Error(`[EmbeddingClient] expected ${expected} vectors, got ${data.length}`);
    }
    const vectors: number[][] = new Array(expected);
    for (const item of data) {
      vectors[item.index] = normalizeL2(item.embedding);
    }
    for (let i = 0; i < expected; i++) {
      if (!vectors[i]) {
        throw new Error(`[EmbeddingClient] missing vector at index ${i}`);
      }
    }
    return vectors;
  }
}

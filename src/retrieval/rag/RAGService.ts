// RAG service - vector retrieval via Ollama embed + Qdrant

import type { RAGConfig } from '@/core/config/rag';
import { logger } from '@/utils/logger';
import { OllamaEmbedClient } from './OllamaEmbedClient';
import { QdrantClient } from './QdrantClient';
import type { RAGDocument, RAGSearchOptions, RAGSearchMultiOptions, RAGSearchResult } from './types';

const DEFAULT_QUERY_PREFIX = 'Instruct: Retrieve relevant conversation history\nQuery: ';

export class RAGService {
  private ollamaEmbedClient: OllamaEmbedClient;
  private qdrantClient: QdrantClient;
  private config: RAGConfig;
  /** Collection names already ensured; ensure at most once per collection on first use. */
  private ensuredCollections = new Set<string>();

  constructor(config: RAGConfig) {
    this.config = config;
    this.ollamaEmbedClient = new OllamaEmbedClient(config.ollama);
    this.qdrantClient = new QdrantClient(config.qdrant);
    logger.info('[RAGService] Initialized');
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /** Ensure collection exists once per collection name; used internally only. */
  private async ensureCollectionOnce(collection: string): Promise<void> {
    if (this.ensuredCollections.has(collection)) {
      return;
    }
    const vectorSize = this.config.defaultVectorSize ?? 2560;
    await this.qdrantClient.ensureCollection(collection, {
      vectorSize,
      distance: this.config.defaultDistance,
    });
    this.ensuredCollections.add(collection);
  }

  async upsertDocuments(collection: string, documents: RAGDocument[]): Promise<void> {
    if (documents.length === 0) return;

    const contents = documents.map((d) => d.content);
    const vectors = await this.ollamaEmbedClient.embed(contents);

    await this.ensureCollectionOnce(collection);

    const points = documents.map((doc, i) => ({
      id: doc.id,
      vector: vectors[i] ?? [],
      payload: {
        ...doc.payload,
        content: doc.content,
      },
    }));

    await this.qdrantClient.upsertPoints(collection, points);
  }

  async vectorSearch(collection: string, query: string, options?: RAGSearchOptions): Promise<RAGSearchResult[]> {
    const prefix = this.config.queryInstructionPrefix ?? DEFAULT_QUERY_PREFIX;
    const queryWithPrefix = prefix + query;
    const [vector] = await this.ollamaEmbedClient.embed(queryWithPrefix);

    if (!vector || vector.length === 0) return [];

    await this.ensureCollectionOnce(collection);

    const limit = options?.limit ?? 5;
    const minScore = options?.minScore ?? 0.7;

    const results = await this.qdrantClient.search(collection, vector, {
      limit,
      withPayload: true,
      filter: options?.filter as Record<string, unknown> | undefined,
    });

    return results
      .filter((r) => r.score >= minScore)
      .map((r) => ({
        id: r.id,
        score: r.score,
        payload: r.payload ?? {},
        content: (r.payload?.content as string) ?? undefined,
      }));
  }

  /**
   * Multi-query vector search: run one search per query, merge by id (keep best score), sort by score, return up to maxTotal.
   * Dedupe and merge are done inside RAG so callers do not need to repeat this logic.
   */
  async vectorSearchMulti(
    collection: string,
    queries: string[],
    options?: RAGSearchMultiOptions,
  ): Promise<RAGSearchResult[]> {
    const trimmed = queries.map((q) => q.trim()).filter(Boolean);
    if (trimmed.length === 0) {
      return [];
    }
    const limitPerQuery = options?.limitPerQuery ?? options?.limit ?? 5;
    const maxTotal = options?.maxTotal ?? 10;
    const minScore = options?.minScore ?? 0.7;

    if (trimmed.length === 1) {
      const results = await this.vectorSearch(collection, trimmed[0], {
        limit: Math.min(limitPerQuery, maxTotal),
        minScore,
        filter: options?.filter,
      });
      return results.slice(0, maxTotal);
    }

    const byId = new Map<string | number, RAGSearchResult>();
    for (const q of trimmed) {
      const results = await this.vectorSearch(collection, q, {
        limit: limitPerQuery,
        minScore,
        filter: options?.filter,
      });
      for (const r of results) {
        const existing = byId.get(r.id);
        if (!existing || r.score > existing.score) {
          byId.set(r.id, r);
        }
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, maxTotal);
  }
}

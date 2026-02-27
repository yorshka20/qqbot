// RAG service - vector retrieval via Ollama embed + Qdrant

import type { RAGConfig } from '@/core/config/rag';
import { logger } from '@/utils/logger';
import { OllamaEmbedClient } from './OllamaEmbedClient';
import { QdrantClient } from './QdrantClient';
import type { RAGDocument, RAGSearchOptions, RAGSearchResult } from './types';

const DEFAULT_QUERY_PREFIX = 'Instruct: Retrieve relevant conversation history\nQuery: ';

export class RAGService {
  private ollamaEmbedClient: OllamaEmbedClient;
  private qdrantClient: QdrantClient;
  private config: RAGConfig;

  constructor(config: RAGConfig) {
    this.config = config;
    this.ollamaEmbedClient = new OllamaEmbedClient(config.ollama);
    this.qdrantClient = new QdrantClient(config.qdrant);
    logger.info('[RAGService] Initialized');
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  async ensureCollection(
    collection: string,
    options?: { vectorSize?: number; distance?: string },
  ): Promise<void> {
    const vectorSize = options?.vectorSize ?? this.config.defaultVectorSize ?? 2560;
    await this.qdrantClient.ensureCollection(collection, {
      vectorSize,
      distance: options?.distance ?? this.config.defaultDistance,
    });
  }

  async upsertDocuments(collection: string, documents: RAGDocument[]): Promise<void> {
    if (documents.length === 0) return;

    const contents = documents.map((d) => d.content);
    const vectors = await this.ollamaEmbedClient.embed(contents);

    await this.ensureCollection(collection);

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
}

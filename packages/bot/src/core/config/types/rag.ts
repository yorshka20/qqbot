// RAG configuration types (OpenAI-compatible embeddings + Qdrant)

/** An OpenAI-compatible embeddings endpoint (SiliconFlow). `url` is the base, without `/embeddings`. */
export interface EmbeddingConfig {
  url: string;
  apiKey: string;
  model: string;
  timeout?: number;
  /** Texts per request. Default 32. */
  batchSize?: number;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  timeout?: number;
}

export interface RAGConfig {
  enabled: boolean;
  embedding: EmbeddingConfig;
  qdrant: QdrantConfig;
  queryInstructionPrefix?: string;
  defaultVectorSize?: number;
  defaultDistance?: 'Cosine' | 'Euclid' | 'Dot';
  /** Idle minutes after last message to close a conversation window (default 5). */
  conversationWindowIdleMinutes?: number;
  /** Max messages per window before closing (default 10). */
  conversationWindowMaxMessages?: number;
}

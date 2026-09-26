// RAG vector retrieval types

export interface RAGDocument {
  id: string | number;
  content: string;
  payload?: Record<string, unknown>;
}

export interface RAGSearchOptions {
  limit?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  /**
   * Qwen3-Embedding instruction prepended to the query (documents carry none).
   * Default: `rag.queryInstructionPrefix`, which is written for conversation history.
   */
  queryPrefix?: string;
}

/** Options for multi-query vector search (merge/dedupe inside RAG). */
export interface RAGSearchMultiOptions extends RAGSearchOptions {
  /** Max results per single query. Default 5. */
  limitPerQuery?: number;
  /** Max total results after merge (dedupe by id, keep best score). Default 10. */
  maxTotal?: number;
}

export interface RAGSearchResult {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
  content?: string;
}

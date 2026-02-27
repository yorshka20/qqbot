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
}

export interface RAGSearchResult {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
  content?: string;
}

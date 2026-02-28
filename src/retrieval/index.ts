// Retrieval service exports

export { RetrievalService } from './RetrievalService';
export { OllamaEmbedClient } from './rag/OllamaEmbedClient';
export { QdrantClient } from './rag/QdrantClient';
export { RAGService } from './rag/RAGService';
export type { RAGDocument, RAGSearchMultiOptions, RAGSearchOptions, RAGSearchResult } from './rag/types';
export { FILTER_REFINE_MAX_ROUNDS, FILTER_SUPPLEMENT_MAX_RESULTS, SearchService } from './searxng/SearchService';
export { SearXNGClient } from './searxng/SearXNGClient';
export type { SearchOptions, SearchResult, SearXNGSearchResponse } from './searxng/types';

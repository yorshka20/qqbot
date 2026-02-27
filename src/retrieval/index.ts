// Retrieval service exports

export { RetrievalService } from './RetrievalService';
export { OllamaEmbedClient } from './rag/OllamaEmbedClient';
export { QdrantClient } from './rag/QdrantClient';
export { RAGService } from './rag/RAGService';
export type { RAGDocument, RAGSearchOptions, RAGSearchResult } from './rag/types';
export { SearchService } from './searxng/SearchService';
export { SearXNGClient } from './searxng/SearXNGClient';
export type { SearchOptions, SearchResult, SearXNGSearchResponse } from './searxng/types';

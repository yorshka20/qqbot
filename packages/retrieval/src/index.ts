/**
 * Retrieval without an LLM: web search (SearXNG direct or over MCP, Serper, provider fallback),
 * page fetching (Readability, Jina Reader, SSRF guards) and vector RAG (embeddings + Qdrant).
 * Deciding what to search and rendering results for a model stay with the bot.
 *
 * `RetrievalService`, the facade the bot injects, is the separate `@qqbot/retrieval/service`
 * entry: it is a tsyringe singleton, and this barrel stays loadable without reflect-metadata.
 */

export type * from './config';
export * from './fetch';
export * from './rag/chunkText';
export { EmbeddingClient } from './rag/EmbeddingClient';
export { QdrantClient, toQdrantPointId } from './rag/QdrantClient';
export { RAGService } from './rag/RAGService';
export type * from './rag/types';
export { killAllMcpChildren } from './searxng/mcp/childReaper';
export { SearchService } from './searxng/SearchService';
export { SearXNGClient } from './searxng/SearXNGClient';
export type { SearchOptions, SearchResult, SearXNGSearchResponse } from './searxng/types';
export { SerperClient } from './serper/SerperClient';
export type { SerperSearchResponse } from './serper/types';
export { RETRIEVAL_OPTIONS } from './tokens';

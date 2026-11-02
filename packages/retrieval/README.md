# @qqbot/retrieval

Retrieval without an LLM: **web search**, **page fetching** and **vector RAG**. The package never
imports the bot. Deciding what to search, rendering results for a model and LLM filter-refine
stay with their callers in the bot (`search` tool, proactive replies).

```
src/
├── RetrievalService.ts   # Facade the bot injects (entry: @qqbot/retrieval/service)
├── config.ts             # MCPConfig (config key `mcp`), RAGConfig (`rag`), RetrievalOptions
├── tokens.ts             # RETRIEVAL_OPTIONS
├── searxng/              # SearchService (provider order + fallback), SearXNG direct and over MCP
├── serper/               # Serper.dev Google SERP client
├── fetch/                # PageContentFetchService (Readability), Jina Reader, SSRF guards
└── rag/                  # EmbeddingClient, QdrantClient, RAGService, chunkText
```

## Entries

- `@qqbot/retrieval` — clients, services, config types, `RETRIEVAL_OPTIONS`. Loads without
  `reflect-metadata`.
- `@qqbot/retrieval/service` — `RetrievalService`, a tsyringe `@singleton()`; tsyringe needs
  `reflect-metadata` the moment it is imported, so it is kept off the root entry.

## Wiring

`RetrievalService` injects `RETRIEVAL_OPTIONS` (`{ mcp?, rag? }`) and `HealthCheckManager`. The
bot registers the options in `core/wiring.ts` from its config. After the DI graph is up,
`connectSearchTransports()` is awaited once so the SearXNG MCP child process is spawned and
handshaken; HTTP transports need no such step. `killAllMcpChildren()` reaps those children on
shutdown.

## Search

- `search(query)` / `searchBatch(queries)` walk the configured provider order
  (`mcp.search.provider`, then `mcp.search.fallbackOrder`). They throw when no provider could serve
  the request, so an empty array always means a backend answered and found nothing.
- SearXNG runs either over its HTTP API (`mode: "direct"`) or the `searxng_web_search` tool of an
  MCP stdio child (`mode: "mcp"`). Only direct SearXNG is registered with `HealthCheckManager`:
  Serper has no free probe.

## Page fetching

`PageContentFetchService.fetchPages(entries, notifier?)` fetches full pages for the top results
(article text via Readability, video page descriptions via per-host selectors), routing public URLs
through Jina Reader when enabled. `urlGuards` refuses internal / private-network URLs. The optional
`FetchProgressNotifier` is told which titles are about to be fetched.

## RAG

1. **Ingest**: text → OpenAI-compatible `POST {url}/embeddings` → upsert into Qdrant (collection
   ensured once on first use). Every point records its model as `embedModel`.
2. **Query**: `queryInstructionPrefix` + query → embed → vector search → filter by `minScore`.

Vectors from different embedding providers are not interchangeable even for the "same" model;
after changing `rag.embedding`, run `bun run rag:reembed`. `defaultVectorSize` must match the model
(2560 for `Qwen/Qwen3-Embedding-4B`).

```jsonc
{
  "rag": {
    "enabled": true,
    "embedding": { "url": "https://api.siliconflow.cn/v1", "apiKey": "sk-...", "model": "Qwen/Qwen3-Embedding-4B" },
    "qdrant": { "url": "http://localhost:6333" },
    "queryInstructionPrefix": "Instruct: Retrieve relevant conversation history\nQuery: ",
    "defaultVectorSize": 2560,
    "defaultDistance": "Cosine"
  }
}
```

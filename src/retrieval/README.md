# Retrieval Module

The retrieval module provides a unified interface for two retrieval capabilities: **web search** (via SearXNG) and **vector RAG** (Retrieval-Augmented Generation via Ollama embeddings + Qdrant). It is designed as a standalone module with a clear facade and delegated submodules.

## Architecture

```
retrieval/
├── RetrievalService.ts    # Facade - delegates to SearchService and RAGService
├── index.ts               # Public exports
├── searxng/               # Web search submodule
│   ├── SearchService.ts   # Search logic (direct/MCP, formatting, smart search)
│   ├── SearXNGClient.ts   # HTTP client for SearXNG API
│   └── types.ts
└── rag/                   # Vector RAG submodule
    ├── RAGService.ts      # RAG logic (embed, upsert, search)
    ├── OllamaEmbedClient.ts
    ├── QdrantClient.ts
    └── types.ts
```

### Design Principles

1. **Facade pattern**: `RetrievalService` is a thin facade that delegates to `SearchService` and `RAGService`. All concrete logic lives in submodules.
2. **Optional RAG**: RAG is only initialized when `ragConfig?.enabled` is true. Search can run independently.
3. **Reuse of project patterns**: Uses `HttpClient`, `HealthCheckable`, and DI container conventions.

---

## Search (SearXNG)

### Modes

- **Direct**: Uses `SearXNGClient` to call the SearXNG HTTP API directly.
- **MCP**: Uses `MCPManager.callTool('searxng_web_search', ...)` when MCP is enabled. Falls back to direct mode if the tool is unavailable.

### Features

- **Basic search**: `search(query, options)` returns `SearchResult[]`.
- **Result formatting**: `formatSearchResults` and `formatMultiSearchResults` produce LLM-ready text via `PromptManager`.
- **Smart search**: `performSmartSearch(userMessage, llmService)` uses an LLM to decide whether to search and which queries to run (supports single and multi-query).
- **Health checks**: In direct mode, `SearXNGClient` is registered with `HealthCheckManager`. Search is skipped if the service is unhealthy.

### Configuration

Search is configured under `mcp` in `BotConfig`:

```json
{
  "mcp": {
    "enabled": true,
    "search": {
      "enabled": true,
      "mode": "direct",
      "maxResults": 8
    },
    "searxng": {
      "url": "https://search.example.com",
      "userAgent": "qqbot/1.0"
    }
  }
}
```

---

## RAG (Vector Retrieval)

### Flow

1. **Document ingestion**: Raw text → embed via Ollama `/api/embed` → L2 normalize → upsert to Qdrant.
2. **Query retrieval**: Query + instruction prefix → embed → vector search in Qdrant → filter by score.

### Components

- **OllamaEmbedClient**: Calls Ollama `/api/embed`, returns L2-normalized vectors. Uses project `HttpClient`.
- **QdrantClient**: `ensureCollection`, `upsertPoints`, `search`. Uses project `HttpClient`.
- **RAGService**: Orchestrates embedding and storage; applies `queryInstructionPrefix` for queries.

### API

| Method | Description |
|--------|-------------|
| `upsertDocuments(collection, documents)` | Embed documents and upsert to Qdrant (collection is ensured once on first use) |
| `vectorSearch(collection, query, options?)` | Embed query, search, return results above `minScore` (collection is ensured once on first use) |

### Configuration

RAG is configured under `rag` in `BotConfig`:

```json
{
  "rag": {
    "enabled": true,
    "ollama": {
      "url": "http://localhost:11434",
      "model": "qwen3-embedding:4b",
      "timeout": 30000
    },
    "qdrant": {
      "url": "http://localhost:6333",
      "apiKey": null,
      "timeout": 30000
    },
    "queryInstructionPrefix": "Instruct: Retrieve relevant conversation history\nQuery: ",
    "defaultVectorSize": 2560,
    "defaultDistance": "Cosine"
  }
}
```

### Query vs Document Embedding

- **Documents**: Stored without any prefix; content is embedded as-is.
- **Queries**: Prefixed with `queryInstructionPrefix` before embedding (e.g. instruction-tuning style for retrieval).

---

## DI Integration

- **Token**: `RETRIEVAL_SERVICE`
- **Registration**: `registerRetrievalService(mcpConfig, ragConfig)` in `ServiceRegistry`
- **Post-init**: `setMCPManager(mcpManager)` is called after MCP is initialized so search can use MCP mode when configured.

---

## Usage

Consumers typically use `RetrievalService` from the DI container:

```ts
const retrieval = container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);

// Search
if (retrieval.isSearchEnabled()) {
  const results = await retrieval.search('query');
  const formatted = retrieval.formatSearchResults(results);
}

// RAG (collections are ensured internally on first use)
if (retrieval.isRAGEnabled()) {
  await retrieval.upsertDocuments('my_collection', documents);
  const hits = await retrieval.vectorSearch('my_collection', 'query', { limit: 5 });
}
```

For direct access to submodules (e.g. tests or custom flows), `SearchService`, `RAGService`, `SearXNGClient`, `OllamaEmbedClient`, and `QdrantClient` are exported from `retrieval/index.ts`.

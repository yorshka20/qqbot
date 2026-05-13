// MCP configuration types

export interface ProxyConfig {
  http?: string;
  https?: string;
}

export interface SearXNGConfig {
  // Required: SearXNG instance URL
  url: string;
  // Optional: HTTP Basic Auth credentials
  authUsername?: string;
  authPassword?: string;
  // Optional: Custom User-Agent header
  userAgent?: string;
  // Optional: Proxy configuration
  proxy?: ProxyConfig;
}

export interface SerperConfig {
  // Required: Serper.dev API key
  apiKey: string;
  // Optional: country code passed as `gl` (e.g. "cn", "us"). Default "cn".
  gl?: string;
  // Optional: language code passed as `hl` (e.g. "zh-cn", "en"). Default derived from SearchConfig.language.
  hl?: string;
  // Optional: API endpoint override (default: "https://google.serper.dev/search")
  endpoint?: string;
  // Optional: per-request timeout in ms (default: 10000)
  timeoutMs?: number;
}

export type MCPRuntime = 'bunx' | 'npx' | 'npm';

export interface MCPServerConfig {
  // Whether to enable MCP server mode (false = direct API mode)
  enabled: boolean;
  // Runtime to use for running MCP server
  runtime: MCPRuntime;
  // Package name (default: "mcp-searxng")
  package?: string;
}

export type SearchMode = 'direct' | 'mcp';
export type SearchProvider = 'searxng' | 'serper';
export type TriggerStrategy = 'llm' | 'keywords' | 'none';

/**
 * Optional config for full-page fetch after filter-refine (fetch HTML and extract main content for top 2-3 results).
 */
export interface SearchFetchConfig {
  // Whether to fetch full page content for top results after filter-refine
  fetchFullPage?: boolean;
  // Max URLs to fetch (default: 3). Same URLs count for both article and video pages.
  maxUrlsToFetch?: number;
  // Max characters per page for article content (proxy for tokens). Default 6000.
  maxCharsPerPage?: number;
  // Max characters per video description. Default 2000.
  maxCharsPerVideoDescription?: number;
  // Timeout in ms for each fetch. Default 10000.
  fetchTimeoutMs?: number;
  // URL patterns to skip fetch entirely (e.g. PDF, binary). Not for video pages.
  skipFetchPatterns?: string[];
  // Host -> CSS selector for video page description block (e.g. B站). If not set, use built-in map.
  videoDescriptionSelectors?: Record<string, string>;
  // Jina Reader integration. When enabled, public-internet URLs are routed
  // through r.jina.ai for anti-bot resilient article extraction; LAN URLs
  // and video pages always fall through to local fetch.
  jina?: JinaReaderConfig;
}

export interface JinaReaderConfig {
  // Enable Jina Reader as the primary fetch path. Default: false.
  enabled?: boolean;
  // Base URL for the Reader endpoint. Default: 'https://r.jina.ai'. Override for self-hosted.
  baseUrl?: string;
  // Timeout in ms for Jina requests. Default: 15000.
  timeoutMs?: number;
}

export interface SearchConfig {
  // Whether to enable automatic search
  enabled: boolean;
  // Backend provider: "searxng" (self-hosted) or "serper" (Serper.dev Google SERP API). Default "searxng".
  provider?: SearchProvider;
  // Search mode for SearXNG backend: "direct" (SearXNG API) or "mcp" (MCP server). Ignored when provider=serper.
  mode: SearchMode;
  // Whether to automatically trigger search
  autoTrigger: boolean;
  // Trigger strategy: "llm" (use LLM to judge), "keywords" (keyword detection), "none" (manual only)
  triggerStrategy?: TriggerStrategy;
  // Maximum number of search results to return (default: 5)
  maxResults?: number;
  // Default language for search results (default: "all"). Use "zh" for Chinese-focused results.
  language?: string;
  // Optional comma-separated engine names (e.g. "baidu,bing") for Chinese-focused results. Engine weighting is done server-side in SearXNG settings.yml.
  engines?: string;
  // Custom keywords for keyword-based trigger strategy
  keywords?: string[];
  // Optional full-page fetch config (after filter-refine)
  fetch?: SearchFetchConfig;
}

export interface MCPConfig {
  // Whether MCP feature is enabled
  enabled: boolean;
  // SearXNG configuration (used when search.provider="searxng")
  searxng: SearXNGConfig;
  // Serper.dev configuration (used when search.provider="serper")
  serper?: SerperConfig;
  // MCP server process configuration
  server: MCPServerConfig;
  // Search behavior configuration
  search: SearchConfig;
}

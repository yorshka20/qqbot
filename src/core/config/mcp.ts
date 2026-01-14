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
export type TriggerStrategy = 'llm' | 'keywords' | 'none';

export interface SearchConfig {
  // Whether to enable automatic search
  enabled: boolean;
  // Search mode: "direct" (SearXNG API) or "mcp" (MCP server)
  mode: SearchMode;
  // Whether to automatically trigger search
  autoTrigger: boolean;
  // Trigger strategy: "llm" (use LLM to judge), "keywords" (keyword detection), "none" (manual only)
  triggerStrategy?: TriggerStrategy;
  // Maximum number of search results to return (default: 5)
  maxResults?: number;
  // Default language for search results (default: "all")
  language?: string;
  // Custom keywords for keyword-based trigger strategy
  keywords?: string[];
}

export interface MCPConfig {
  // Whether MCP feature is enabled
  enabled: boolean;
  // SearXNG configuration
  searxng: SearXNGConfig;
  // MCP server process configuration
  server: MCPServerConfig;
  // Search behavior configuration
  search: SearchConfig;
}

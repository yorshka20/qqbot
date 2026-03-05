// SearXNG search types

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  engine?: string;
}

export interface SearchOptions {
  pageno?: number;
  /** Rare use only (e.g. pure news). Prefer adding year in query keywords for timeliness so ranking keeps authority/relevance. */
  timeRange?: 'day' | 'month' | 'year';
  language?: string;
  safesearch?: number;
  maxResults?: number;
  /** Comma-separated engine names (e.g. "baidu,bing") for Chinese-focused results */
  engines?: string;
  /** Comma-separated categories (e.g. "general") */
  categories?: string;
}

export interface SearXNGSearchResponse {
  query: string;
  results: Array<{
    title: string;
    url: string;
    content?: string;
    snippet?: string;
    engine?: string;
  }>;
}

// SearXNG search types

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  engine?: string;
  /**
   * Publication date as the backend reported it, free-form ("2 days ago",
   * "Oct 14, 2026"). Carried because a dateless snippet gives the model no way
   * to tell a current page from an archived one, which is how stale facts get
   * quoted as current.
   */
  date?: string;
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

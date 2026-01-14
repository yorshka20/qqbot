// Search service types

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  engine?: string;
}

export interface SearchOptions {
  pageno?: number;
  timeRange?: 'day' | 'month' | 'year';
  language?: string;
  safesearch?: number;
  maxResults?: number;
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

// Serper.dev API response types

export interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
  date?: string;
  sitelinks?: Array<{ title?: string; link?: string }>;
}

export interface SerperSearchResponse {
  searchParameters?: Record<string, unknown>;
  organic?: SerperOrganicResult[];
  answerBox?: {
    title?: string;
    snippet?: string;
    link?: string;
  };
  knowledgeGraph?: Record<string, unknown>;
  peopleAlsoAsk?: Array<{ question?: string; snippet?: string; link?: string }>;
  relatedSearches?: Array<{ query?: string }>;
  credits?: number;
}

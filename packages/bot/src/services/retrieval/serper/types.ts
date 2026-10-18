// Serper.dev API response types

export interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
  date?: string;
  sitelinks?: Array<{ title?: string; link?: string }>;
}

export interface SerperKnowledgeGraph {
  title?: string;
  type?: string;
  description?: string;
  descriptionLink?: string;
  website?: string;
  attributes?: Record<string, string>;
}

export interface SerperTopStory {
  title?: string;
  link?: string;
  source?: string;
  date?: string;
  snippet?: string;
}

export interface SerperSearchResponse {
  searchParameters?: Record<string, unknown>;
  organic?: SerperOrganicResult[];
  answerBox?: {
    title?: string;
    snippet?: string;
    answer?: string;
    link?: string;
  };
  knowledgeGraph?: SerperKnowledgeGraph;
  peopleAlsoAsk?: Array<{ question?: string; snippet?: string; link?: string }>;
  relatedSearches?: Array<{ query?: string }>;
  topStories?: SerperTopStory[];
  credits?: number;
}

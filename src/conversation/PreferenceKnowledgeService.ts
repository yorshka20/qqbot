// PreferenceKnowledgeService - RAG retrieval for proactive reply (Phase 2)

export interface PreferenceKnowledgeRetrieveOptions {
  /** Max number of chunks to return. Default implementation may ignore. */
  limit?: number;
}

/**
 * Service to retrieve knowledge chunks for a preference (persona) and query/topic.
 * Used by proactive reply flow to inject RAG context into the main LLM prompt.
 * Phase 2: default implementation returns empty array; real RAG can be wired later.
 */
export interface PreferenceKnowledgeService {
  /**
   * Retrieve relevant knowledge chunks for the given preference and query/topic.
   * @param preferenceKey - e.g. "preference.tech_expert"
   * @param queryOrTopic - topic or short query (e.g. from Ollama analysis or recent messages)
   * @param options - optional e.g. limit
   * @returns Array of text chunks (may be empty)
   */
  retrieve(
    preferenceKey: string,
    queryOrTopic: string,
    options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]>;
}

/**
 * Default implementation: no RAG backend, always returns empty array.
 * Replace with a real implementation (e.g. vector store) when knowledge base is ready.
 */
export class DefaultPreferenceKnowledgeService implements PreferenceKnowledgeService {
  async retrieve(
    _preferenceKey: string,
    _queryOrTopic: string,
    _options?: PreferenceKnowledgeRetrieveOptions,
  ): Promise<string[]> {
    return [];
  }
}

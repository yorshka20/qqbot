// Dependency injection tokens
// Centralized token management for dependency injection

export const DITokens = {
  COMMAND_MANAGER: 'CommandManager',
  HOOK_MANAGER: 'HookManager',
  TASK_MANAGER: 'TaskManager',
  AI_MANAGER: 'AIManager',
  AI_SERVICE: 'AIService',
  CONTEXT_MANAGER: 'ContextManager',
  DATABASE_MANAGER: 'DatabaseManager',
  API_CLIENT: 'APIClient',
  CONFIG: 'Config',
  PROMPT_MANAGER: 'PromptManager',
  LLM_SERVICE: 'LLMService',
  PLUGIN_MANAGER: 'PluginManager',
  CONVERSATION_CONFIG_SERVICE: 'ConversationConfigService',
  GLOBAL_CONFIG_MANAGER: 'GlobalConfigManager',
  SEARCH_SERVICE: 'SearchService',
  HEALTH_CHECK_MANAGER: 'HealthCheckManager',
  THREAD_SERVICE: 'ThreadService',
  PROACTIVE_CONVERSATION_SERVICE: 'ProactiveConversationService',
  MESSAGE_API: 'MessageAPI',
  SUMMARIZE_SERVICE: 'SummarizeService',
  GROUP_HISTORY_SERVICE: 'GroupHistoryService',
  OLLAMA_PRELIMINARY_ANALYSIS_SERVICE: 'OllamaPreliminaryAnalysisService',
  PREFERENCE_KNOWLEDGE_SERVICE: 'PreferenceKnowledgeService',
  PROACTIVE_THREAD_PERSISTENCE_SERVICE: 'ProactiveThreadPersistenceService',
  THREAD_CONTEXT_COMPRESSION_SERVICE: 'ThreadContextCompressionService',
} as const;

export type DIToken = (typeof DITokens)[keyof typeof DITokens];

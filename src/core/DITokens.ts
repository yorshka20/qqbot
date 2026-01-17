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
  PLUGIN_MANAGER: 'PluginManager',
  CONVERSATION_CONFIG_SERVICE: 'ConversationConfigService',
  GLOBAL_CONFIG_MANAGER: 'GlobalConfigManager',
} as const;

export type DIToken = (typeof DITokens)[keyof typeof DITokens];

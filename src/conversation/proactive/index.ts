// Proactive scope: debounced analysis, Ollama, proactive reply, preference knowledge, thread persistence

export {
  DefaultPreferenceKnowledgeService,
  type PreferenceKnowledgeRetrieveOptions,
  type PreferenceKnowledgeService,
  SearXNGPreferenceKnowledgeService,
} from './PreferenceKnowledgeService';
export {
  ProactiveConversationService,
  type ProactiveGroupConfig,
} from './ProactiveConversationService';
export {
  ProactiveReplyContextBuilder,
  type ProactiveReplyContextBuilderDeps,
} from './ProactiveReplyContextBuilder';
export {
  DefaultProactiveThreadPersistenceService,
  type ProactiveThreadPersistenceService,
} from './ProactiveThreadPersistenceService';

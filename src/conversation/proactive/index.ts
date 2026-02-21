// Proactive scope: debounced analysis, Ollama, proactive reply, preference knowledge, thread persistence

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
export {
  DefaultPreferenceKnowledgeService,
  SearXNGPreferenceKnowledgeService,
  type PreferenceKnowledgeService,
  type PreferenceKnowledgeRetrieveOptions,
} from './PreferenceKnowledgeService';

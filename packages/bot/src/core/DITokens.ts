// Dependency injection tokens — single source of truth for both the token
// string values (consumed by tsyringe) and their registration contract
// (required vs optional).
//
// Why this exists:
//   - `verifyServices()` in `ServiceRegistry` needs to know which tokens MUST
//     be registered after bootstrap; it throws on missing required tokens so
//     `bun run smoke-test` catches DI drift.
//   - Plugin authors need to know which tokens are safe to `container.resolve`
//     directly versus which require an `isRegistered` guard. Guarding a
//     required token is a smell — it masks bootstrap bugs as silent fallbacks.
//
// Contract per metadata flag:
//   - required: true  → bootstrap always registers this token. Consumers
//     should `container.resolve()` directly. `verifyServices()` throws if
//     it's missing.
//   - required: false → registered only when a feature/adapter/config is
//     active. Field `gatedBy` documents the gate. Consumers MUST guard with
//     `container.isRegistered()` before resolving.
//
// Adding a new token: call `defineToken(...)` with explicit metadata. There
// is no default — TypeScript forces you to pick a side at definition time so
// the requirement contract can never drift from the registration sites.

interface TokenMeta {
  /** True = bootstrap always registers; consumers may `resolve` directly.
   *  False = gated by config/adapter; consumers must `isRegistered`-guard. */
  required: boolean;
  /** When `required: false`, a short reason describing the gate (e.g.
   *  `"SQLite adapter only"`, `"avatar.enabled config"`). Required for
   *  optional tokens so consumers know what to check. */
  gatedBy?: string;
}

const TOKEN_META = new Map<string, TokenMeta>();

function defineToken<V extends string>(value: V, meta: TokenMeta): V {
  if (meta.required === false && !meta.gatedBy) {
    throw new Error(`[DITokens] Optional token "${value}" must specify gatedBy`);
  }
  TOKEN_META.set(value, meta);
  return value;
}

export const DITokens = {
  // ── Core infrastructure (required) ──
  /** App-wide config object. Registered first by `ServiceRegistry.registerInfrastructureServices`. */
  CONFIG: defineToken('Config', { required: true }),
  /** Outbound API client (HTTP). Registered alongside CONFIG. */
  API_CLIENT: defineToken('APIClient', { required: true }),
  /** Aggregate health-check manager. Registered by `bootstrap.ts`. */
  HEALTH_CHECK_MANAGER: defineToken('HealthCheckManager', { required: true }),
  /** Lifecycle bus for graceful shutdown. */
  LIFECYCLE: defineToken('Lifecycle', { required: true }),

  // ── Database / persistence (required) ──
  DATABASE_MANAGER: defineToken('DatabaseManager', { required: true }),
  MEMORY_SERVICE: defineToken('MemoryService', { required: true }),
  GLOBAL_CONFIG_MANAGER: defineToken('GlobalConfigManager', { required: true }),
  CONVERSATION_CONFIG_SERVICE: defineToken('ConversationConfigService', { required: true }),

  // ── AI / LLM (required) ──
  AI_MANAGER: defineToken('AIManager', { required: true }),
  AI_SERVICE: defineToken('AIService', { required: true }),
  PROMPT_MANAGER: defineToken('PromptManager', { required: true }),
  LLM_SERVICE: defineToken('LLMService', { required: true }),
  PROVIDER_SELECTOR: defineToken('ProviderSelector', { required: true }),
  PROVIDER_ROUTER: defineToken('ProviderRouter', { required: true }),
  SUMMARIZE_SERVICE: defineToken('SummarizeService', { required: true }),
  SUB_AGENT_MANAGER: defineToken('SubAgentManager', { required: true }),
  MEMORY_EXTRACT_SERVICE: defineToken('MemoryExtractService', { required: true }),

  // ── Conversation pipeline (required) ──
  CONVERSATION_HISTORY_SERVICE: defineToken('ConversationHistoryService', { required: true }),
  CONTEXT_MANAGER: defineToken('ContextManager', { required: true }),
  MESSAGE_PIPELINE: defineToken('MessagePipeline', { required: true }),
  MESSAGE_API: defineToken('MessageAPI', { required: true }),
  CONVERSATION_MANAGER: defineToken('ConversationManager', { required: true }),
  REPLY_SYSTEM: defineToken('ReplySystem', { required: true }),
  PROCESS_STAGE_INTERCEPTOR_REGISTRY: defineToken('ProcessStageInterceptorRegistry', { required: true }),
  PROMPT_INJECTION_REGISTRY: defineToken('PromptInjectionRegistry', { required: true }),
  THREAD_SERVICE: defineToken('ThreadService', { required: true }),
  PROACTIVE_CONVERSATION_SERVICE: defineToken('ProactiveConversationService', { required: true }),
  PREFERENCE_KNOWLEDGE_SERVICE: defineToken('PreferenceKnowledgeService', { required: true }),

  // ── Hooks / commands / tools (required) ──
  HOOK_MANAGER: defineToken('HookManager', { required: true }),
  COMMAND_MANAGER: defineToken('CommandManager', { required: true }),
  TOOL_MANAGER: defineToken('ToolManager', { required: true }),
  PLUGIN_MANAGER: defineToken('PluginManager', { required: true }),
  EVENT_ROUTER: defineToken('EventRouter', { required: true }),

  // ── Auxiliary services (required) ──
  RETRIEVAL_SERVICE: defineToken('RetrievalService', { required: true }),
  FILE_READ_SERVICE: defineToken('FileReadService', { required: true }),
  PROJECT_REGISTRY: defineToken('ProjectRegistry', { required: true }),
  VIDEO_DOWNLOAD_SERVICE: defineToken('VideoDownloadService', { required: true }),
  RESOURCE_CLEANUP_SERVICE: defineToken('ResourceCleanupService', { required: true }),

  // ── Agenda framework (required — initialized unconditionally in ConversationInitializer) ──
  AGENDA_SERVICE: defineToken('AgendaService', { required: true }),
  AGENT_LOOP: defineToken('AgentLoop', { required: true }),
  INTERNAL_EVENT_BUS: defineToken('InternalEventBus', { required: true }),
  AGENDA_REPORTER: defineToken('AgendaReporter', { required: true }),
  SCHEDULE_FILE_SERVICE: defineToken('ScheduleFileService', { required: true }),

  // ── Persona / mind subsystem (required — PersonaInitializer always returns components) ──
  PERSONA_SERVICE: defineToken('PersonaService', { required: true }),
  PERSONA_CONFIG: defineToken('PersonaConfig', { required: true }),
  PERSONA_MODULATION_PROVIDER: defineToken('MindModulationProvider', { required: true }),

  // ── Avatar dependents that bootstrap.ts always registers (required) ──
  TTS_MANAGER: defineToken('TTSManager', { required: true }),
  AVATAR_SESSION_SERVICE: defineToken('AvatarSessionService', { required: true }),
  AVATAR_MEMORY_EXTRACTION_COORDINATOR: defineToken('AvatarMemoryExtractionCoordinator', { required: true }),
  LIVEMODE_STATE: defineToken('LivemodeState', { required: true }),

  // ── Optional: SQLite-only persistence ──
  /** Optional — SQLite adapter only. */
  EPIGENETICS_STORE: defineToken('EpigeneticsStore', {
    required: false,
    gatedBy: 'SQLite adapter (skipped on MongoDB)',
  }),
  /** Optional — SQLite adapter only. */
  MEMORY_FACT_META_SERVICE: defineToken('MemoryFactMetaService', {
    required: false,
    gatedBy: 'SQLite adapter (skipped on MongoDB)',
  }),

  // ── Optional: avatar / live integrations (config-gated) ──
  /** Optional — only registered when `avatar.enabled` and avatar init succeeds. */
  AVATAR_SERVICE: defineToken('AvatarService', {
    required: false,
    gatedBy: 'avatar.enabled config',
  }),

  /** Optional — only registered when `bilibili.live` config block is present. */
  BILIBILI_LIVE_CLIENT: defineToken('BilibiliLiveClient', {
    required: false,
    gatedBy: 'bilibili.live config block',
  }),
  /** Optional — only registered when `bilibili.live` config block is present. */
  BILIBILI_LIVE_BRIDGE: defineToken('BilibiliLiveBridge', {
    required: false,
    gatedBy: 'bilibili.live config block',
  }),
  /** Optional — only registered when `bilibili.live` config block is present. */
  BILIBILI_DANMAKU_STORE: defineToken('BilibiliDanmakuStore', {
    required: false,
    gatedBy: 'bilibili.live config block',
  }),

  // ── Optional: cluster + claude-code integrations ──
  /** Optional — only registered when `cluster` config block is present. */
  CLUSTER_MANAGER: defineToken('ClusterManager', {
    required: false,
    gatedBy: 'cluster config block',
  }),
  /** Optional — only registered when `claudeCode.enabled` is true. */
  CLAUDE_CODE_SERVICE: defineToken('ClaudeCodeService', {
    required: false,
    gatedBy: 'claudeCode.enabled config',
  }),
  /** Required — registered unconditionally by ConversationInitializer.createWiringServices. */
  PRELIMINARY_ANALYSIS_SERVICE: defineToken('PreliminaryAnalysisService', { required: true }),
  /** Required — registered unconditionally by ConversationInitializer.createWiringServices. */
  PROACTIVE_THREAD_PERSISTENCE_SERVICE: defineToken('ProactiveThreadPersistenceService', { required: true }),
  /** Required — registered unconditionally by ConversationInitializer.createWiringServices. */
  THREAD_CONTEXT_COMPRESSION_SERVICE: defineToken('ThreadContextCompressionService', { required: true }),
} as const;

export type DIToken = (typeof DITokens)[keyof typeof DITokens];

/** Returns every token whose `required: true`. Used by `verifyServices()`. */
export function getRequiredTokens(): readonly string[] {
  const out: string[] = [];
  for (const [token, meta] of TOKEN_META) {
    if (meta.required) out.push(token);
  }
  return out;
}

/** True iff `token` is declared `required: true`. */
export function isRequiredToken(token: string): boolean {
  return TOKEN_META.get(token)?.required === true;
}

/** Lookup metadata (gatedBy reason etc.) for a token. */
export function getTokenMeta(token: string): TokenMeta | undefined {
  return TOKEN_META.get(token);
}

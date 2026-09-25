// Dependency injection tokens — single source of truth for both the token
// string values (consumed by tsyringe) and their registration contract
// (required vs optional).
//
// Why this exists:
//   - `DIContainer.verifyRequiredTokens()` needs to know which tokens MUST
//     be registered after bootstrap; it throws on missing required tokens so
//     `bun run smoke-test` catches DI drift.
//   - Plugin authors need to know which tokens are safe to `container.resolve`
//     directly versus which require an `isRegistered` guard. Guarding a
//     required token is a smell — it masks bootstrap bugs as silent fallbacks.
//
// Contract per metadata flag:
//   - required: true  → bootstrap always registers this token. Consumers
//     should `container.resolve()` directly. `verifyRequiredTokens()` throws if
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
  /** App-wide config object. Registered first by `ConversationInitializer`. */
  CONFIG: defineToken('Config', { required: true }),
  /** Outbound API client (HTTP). Registered alongside CONFIG. */
  API_CLIENT: defineToken('APIClient', { required: true }),

  // ── Database / persistence (required) ──

  // ── AI / LLM (required) ──
  AI_MANAGER: defineToken('AIManager', { required: true }),
  PROMPT_MANAGER: defineToken('PromptManager', { required: true }),
  SUB_AGENT_MANAGER: defineToken('SubAgentManager', { required: true }),

  // ── Conversation pipeline (required) ──

  // ── Hooks / commands / tools (required) ──
  PERMISSION_CHECKER: defineToken('PermissionChecker', { required: true }),
  TOOL_MANAGER: defineToken('ToolManager', { required: true }),
  EVENT_ROUTER: defineToken('EventRouter', { required: true }),

  // ── Auxiliary services (required) ──

  // ── Agenda framework (required — initialized unconditionally in ConversationInitializer) ──
  AGENDA_SERVICE: defineToken('AgendaService', { required: true }),
  AGENT_LOOP: defineToken('AgentLoop', { required: true }),
  INTERNAL_EVENT_BUS: defineToken('InternalEventBus', { required: true }),
  AGENDA_REPORTER: defineToken('AgendaReporter', { required: true }),
  SCHEDULE_FILE_SERVICE: defineToken('ScheduleFileService', { required: true }),

  // ── Fan-out (required — registered unconditionally in ConversationInitializer, before agenda) ──
  /** Multi-provider: one registration per class in FANOUT_CONTEXTS. */
  FANOUT_CONTEXTS: defineToken('FanoutContexts', { required: true }),

  // ── Persona / mind subsystem (required — PersonaInitializer always returns components) ──
  PERSONA_SERVICE: defineToken('PersonaService', { required: true }),
  PERSONA_CONFIG: defineToken('PersonaConfig', { required: true }),
  PERSONA_MODULATION_PROVIDER: defineToken('MindModulationProvider', { required: true }),

  // ── Audit event ledger (required — in-memory, always registered) ──
  AUDIT_EVENT_STORE: defineToken('AuditEventStore', { required: true }),

  // ── Session memo blackboard (required — LLM-writable per-session notes) ──
  SESSION_MEMO_STORE: defineToken('SessionMemoStore', { required: true }),

  // ── Avatar dependents that bootstrap.ts always registers (required) ──
  TTS_MANAGER: defineToken('TTSManager', { required: true }),

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

  // ── Admin alerting (required — registered unconditionally in bootstrap.ts) ──
} as const;

export type DIToken = (typeof DITokens)[keyof typeof DITokens];

/** Returns every token whose `required: true`. Used by `DIContainer.verifyRequiredTokens()`. */
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

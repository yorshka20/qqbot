// AI configuration

import type { AIProviderConfig, AIProviderType } from './providers';

export type AIProviderCapability =
  | 'llm'
  | 'function_calling'
  | 'native_web_search'
  | 'vision'
  | 'video_analysis'
  | 'text2img'
  | 'img2img'
  | 'i2v';

/**
 * Default providers configuration (by capability)
 */
export interface DefaultProvidersConfig {
  llm?: AIProviderType; // Default LLM provider name
  function_calling?: AIProviderType; // Default function-calling provider name (usually same as llm)
  native_web_search?: AIProviderType; // Unused for selection (native search is a per-provider flag); kept for index type compatibility
  vision?: AIProviderType; // Default vision/multimodal provider name
  video_analysis?: AIProviderType; // Default video analysis provider name
  text2img?: AIProviderType; // Default text-to-image provider name
  img2img?: AIProviderType; // Default image-to-image provider name
  i2v?: AIProviderType; // Default image-to-video provider name
}

/**
 * Session-level provider override configuration
 */
export interface SessionProviderConfig {
  llm?: AIProviderType;
  function_calling?: AIProviderType;
  native_web_search?: AIProviderType;
  vision?: AIProviderType;
  video_analysis?: AIProviderType;
  text2img?: AIProviderType;
  img2img?: AIProviderType;
  i2v?: AIProviderType;
}

declare module '@/database/models/types' {
  interface ProviderSelection {
    function_calling?: string;
    video_analysis?: string;
  }
}

/**
 * Auto-switch configuration
 */
export interface AutoSwitchConfig {
  // Automatically switch to vision provider when message contains images
  // but current provider doesn't support vision
  enableVisionFallback?: boolean;
}

/**
 * Task-specific provider configuration.
 * Overrides defaultProviders for specific internal tasks.
 * Each task falls back to defaultProviders.llm if not specified.
 */
export interface TaskProvidersConfig {
  /** Provider for memory extraction (MemoryPlugin) */
  memoryExtract?: string;
  /**
   * Provider for the group_day fan-out (daily report, comic, memory extraction). Every task
   * of one run shares it: a different provider or model is a different prefix cache.
   */
  groupDay?: string;
  /** Model override for the group_day provider (optional) */
  groupDayModel?: string;
  /** Provider for thread/context summarization */
  summarize?: string;
  /** Provider for lightweight/fast LLM calls (prefix-invitation, analysis) */
  lite?: string;
  /** Model override for lite provider (optional) */
  liteModel?: string;
  /**
   * Provider for article analysis (WeChatArticleAnalysisService).
   * Uses generateFixed (no fallback, retry-only) — ideal for cost-sensitive batch tasks.
   * Falls back to 'doubao' if not specified.
   */
  articleAnalysis?: string;
  /** Model override for article analysis provider (optional) */
  articleAnalysisModel?: string;
  /** Provider for todo optimization (TodoPlugin) */
  todoOptimize?: string;
  /** Model override for todo optimization provider (optional) */
  todoOptimizeModel?: string;
  /**
   * Provider(s) for sub-agent execution (research, analysis, etc.).
   * String = fixed provider. Array = random selection per call.
   * Should be a cost-effective provider with tool-use support (e.g. deepseek, gemini, openai).
   * Falls back to defaultProviders.llm if not specified.
   */
  subagent?: string | string[];
  /** Model override for sub-agent provider (only used when subagent is a single string) */
  subagentModel?: string;
}

/**
 * Provider-neutral reasoning effort scale. `'none'` asks for no thinking and
 * `'minimal'` for the least a model can do. Each provider maps it onto the
 * values its own API and the target model accept — the sets differ per vendor
 * and sometimes per model, and an unsupported value is a 400 — so a provider
 * never forwards it verbatim.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/**
 * Chat-pipeline reasoning configuration. Split by whether the turn involves
 * tool invocation because the two jobs have different reasoning needs: a
 * zero-tool turn (pure chat / roleplay) mostly spends thinking "planning" a
 * persona the system prompt already pins down, while a tool-use turn gains
 * from it in tool selection, argument construction and multi-step planning.
 * Defaults in `DEFAULT_CHAT_REASONING_EFFORTS`.
 *
 * Overridable via `ai.chat` in config. Applied to both the reply pipeline
 * (`PromptAssemblyStage`) and proactive replies.
 */
export interface AIChatConfig {
  /** Reasoning effort for chat turns with no tool definitions. */
  reasoningEffort?: ReasoningEffort;
  /** Reasoning effort for chat turns that have tool definitions. */
  toolReasoningEffort?: ReasoningEffort;
  /**
   * Reasoning effort applied when (a) the selected provider is in
   * `replyModeProviders` AND `metadata.replyMode === 'quick'`, OR (b) the
   * selected provider is in `lowEffortProviders` (always, regardless of
   * replyMode). Tool turns are never downgraded — they always use
   * `toolReasoningEffort`.
   */
  quickReasoningEffort?: ReasoningEffort;
  /**
   * Provider names that respond to runtime `replyMode` downgrade. Defaults
   * to `['deepseek', 'openai', 'gemini']` — the day-to-day workhorses where
   * shaving reasoning is a win. Premium providers (e.g. `anthropic`) are
   * intentionally absent so they keep running at full quality regardless of
   * routing decisions upstream.
   */
  replyModeProviders?: string[];
  /**
   * Provider names that always run at `quickReasoningEffort`, regardless of
   * `replyMode`. Defaults to `['doubao']` — used as a low-quality fallback
   * that isn't part of the main prompt tuning effort, so reasoning budget
   * would be wasted. Tool turns still escape this (they use
   * `toolReasoningEffort`).
   */
  lowEffortProviders?: string[];
  /**
   * Max tool-calling rounds per reply generation (one round = one LLM call
   * that may execute several parallel tool calls). Past the cap the loop
   * forces a final text-only generation. Default 5.
   */
  maxToolRounds?: number;
}

export type ChatReasoningEfforts = Required<
  Pick<AIChatConfig, 'reasoningEffort' | 'toolReasoningEffort' | 'quickReasoningEffort'>
>;

/**
 * Chat and tool turns default to `'medium'`, the pipeline's historical behavior; the split
 * exists so operators can tune them apart. This is the general QQ conversation pipeline —
 * the avatar path has its own knob (`avatar.llmReasoningEffort`), because live roleplay pays
 * for thinking in TTFT and character coherence.
 */
export const DEFAULT_CHAT_REASONING_EFFORTS: ChatReasoningEfforts = {
  reasoningEffort: 'medium',
  toolReasoningEffort: 'medium',
  quickReasoningEffort: 'minimal',
};

/**
 * Per-model pricing. Text models are priced per 1M tokens; image models per generated image,
 * because image providers report no token counts.
 * Keys are model name strings matching the `model` field persisted in TokenUsageRecord.
 * Glob-style trailing wildcard (`*`) is supported for prefix matching
 * (e.g. `"gpt-4o*"` covers `gpt-4o`, `gpt-4o-mini`, etc.).
 */
export type ModelPricingEntry = TokenPricing | ImagePricing;

/** USD per 1M tokens. */
export interface TokenPricing {
  input: number;
  output: number;
  /** Prompt tokens served from the provider's prefix cache; without it they cost `input`. */
  cachedInput?: number;
}

export interface ImagePricing {
  /** USD per generated image. */
  perImage: number;
}

/**
 * Spend controls, all priced with `modelPricing` over the recorded usage. Each one
 * is active only when its key is set. Days are the server's local calendar days, the same
 * days `/usage` reports.
 */
export interface AIUsageConfig {
  /** Per-user spend cap per day, in USD. Past it the user's replies are refused. Admins are never capped. */
  userDailyLimitUsd?: number;
  /** Per-user caps keyed by user id; an entry wins over `userDailyLimitUsd`. */
  userDailyLimitOverrides?: Record<string, number>;
  /** A group is told each time its spend for the day passes another multiple of this, in USD. */
  groupSpendStepUsd?: number;
  /** A session is told when a reply's opening prompt reaches this many tokens. */
  promptAlertTokens?: number;
  /** Minimum gap between two prompt alerts in one session, in minutes. Default 30. */
  promptAlertCooldownMinutes?: number;
}

export interface AIConfig {
  // Default providers by capability (llm, vision, text2img, etc.)
  defaultProviders?: DefaultProvidersConfig;
  // Provider configurations
  providers: Record<string, AIProviderConfig>;
  /**
   * Per-model token pricing for cost estimation in /usage reports.
   * Key = model name (or prefix with trailing `*`); value = USD per 1M tokens.
   */
  modelPricing?: Record<string, ModelPricingEntry>;
  usage?: AIUsageConfig;
  // Session-level provider overrides (key is sessionId)
  sessionProviders?: Record<string, SessionProviderConfig>;
  // Auto-switch configuration
  autoSwitch?: AutoSwitchConfig;
  /**
   * Chat-pipeline reasoning effort (split by tool-use vs zero-tool).
   * See `AIChatConfig` for rationale. Both fields optional, both have
   * sane defaults applied in PromptAssemblyStage.
   */
  chat?: AIChatConfig;
  /**
   * Use skills (native tool/function calling) for reply generation (single LLM call with tool loop).
   * When true (default), ReplySystem uses ReplyGenerationService + skills to generate replies.
   */
  useSkills?: boolean;
  /**
   * Task-specific provider overrides.
   * Used by plugins and internal services for specific LLM tasks.
   * Falls back to defaultProviders.llm if not specified.
   */
  taskProviders?: TaskProvidersConfig;
  /**
   * Providers that support tool/function calling.
   * Used to determine whether to inject tool instructions and pass tools to the provider.
   */
  toolUseProviders: string[];
  /**
   * LLM fallback configuration.
   * Defines fallback order when the primary provider fails.
   */
  llmFallback: {
    /** Ordered list of provider names for fallback (by cost, cheapest first) */
    fallbackOrder: string[];
  };
  /**
   * Per-provider token rate limiting (TPM — tokens per minute).
   * Prevents exceeding provider rate limits by throttling requests.
   *
   * Example:
   * ```jsonc
   * "rateLimit": {
   *   "defaultTokensPerMinute": 0,       // 0 = unlimited (default)
   *   "providers": {
   *     "anthropic": { "tokensPerMinute": 30000 },
   *     "openai":    { "tokensPerMinute": 60000 }
   *   }
   * }
   * ```
   */
  rateLimit?: {
    /** Default TPM for providers without explicit config. 0 = unlimited. */
    defaultTokensPerMinute?: number;
    /** Per-provider TPM overrides. */
    providers?: Record<string, { tokensPerMinute: number }>;
  };
}

export interface ContextMemoryConfig {
  // Maximum number of messages to store in memory buffer
  maxBufferSize?: number;
  // Maximum number of history messages to include in AI prompt
  maxHistoryMessages?: number;
}

// Re-export provider types
export type {
  AIProviderConfig,
  AIProviderType,
  AnthropicProviderConfig,
  DeepSeekProviderConfig,
  DoubaoProviderConfig,
  GeminiLLmConfig,
  GeminiProviderConfig,
  GeminiText2ImgConfig,
  GeminiVisionConfig,
  GoogleCloudRunProviderConfig,
  GroqProviderConfig,
  LaozhangLLmConfig,
  LaozhangProviderConfig,
  LaozhangText2ImgConfig,
  LaozhangVisionConfig,
  LocalText2ImageProviderConfig,
  MinimaxProviderConfig,
  NovelAIProviderConfig,
  OllamaProviderConfig,
  OpenAIImageConfig,
  OpenAIProviderConfig,
  OpenRouterProviderConfig,
  RunPodProviderConfig,
} from './providers';

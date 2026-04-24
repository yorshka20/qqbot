// AI configuration

import type { AIProviderConfig, AIProviderType } from './providers';

export type AIProviderCapability = 'llm' | 'vision' | 'video_analysis' | 'text2img' | 'img2img' | 'i2v';

/**
 * Default providers configuration (by capability)
 */
export interface DefaultProvidersConfig {
  llm?: AIProviderType; // Default LLM provider name
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
  vision?: AIProviderType;
  video_analysis?: AIProviderType;
  text2img?: AIProviderType;
  img2img?: AIProviderType;
  i2v?: AIProviderType;
}

declare module '@/database/models/types' {
  interface ProviderSelection {
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
  /** Provider for thread/context summarization */
  summarize?: string;
  /** Provider for lightweight/fast LLM calls (prefix-invitation, analysis) */
  lite?: string;
  /** Model override for lite provider (optional) */
  liteModel?: string;
  /** Provider for convert-to-card LLM calls */
  convert?: string;
  /** Model override for convert provider (optional) */
  convertModel?: string;
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
 * Reasoning effort levels passed through to thinking-capable providers
 * (e.g. Groq qwen3-*, OpenAI o-series, Anthropic extended-thinking). `'none'`
 * fully disables thinking on providers that support that switch; `'minimal'`
 * is OpenAI-specific and maps to the smallest thinking budget.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/**
 * Chat-pipeline reasoning configuration. Split by whether the turn involves
 * tool invocation because the two jobs have fundamentally different reasoning
 * needs:
 *
 * - Zero-tool turn (pure chat / roleplay): thinking is usually *worse* than
 *   useless — the model wastes tokens "planning" persona/style that the
 *   system prompt already pins down, and the full TTFT gets blocked behind
 *   the hidden `<think>` block. Default `'none'`.
 * - Tool-use turn: thinking improves tool selection, argument construction,
 *   and multi-step planning. Default `'medium'`.
 *
 * Overridable via `ai.chat` in config. Applied in `PromptAssemblyStage`.
 */
export interface AIChatConfig {
  /** Reasoning effort for chat turns with no tool definitions. Default `'none'`. */
  reasoningEffort?: ReasoningEffort;
  /** Reasoning effort for chat turns that have tool definitions. Default `'medium'`. */
  toolReasoningEffort?: ReasoningEffort;
}

export interface AIConfig {
  // Default providers by capability (llm, vision, text2img, etc.)
  defaultProviders?: DefaultProvidersConfig;
  // Provider configurations
  providers: Record<string, AIProviderConfig>;
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
  // Whether to use summary memory (requires AI manager)
  useSummary?: boolean;
  // Threshold for triggering summary (number of messages)
  summaryThreshold?: number;
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

// AI configuration

import type { AIProviderConfig, AIProviderType } from './providers';

export type AIProviderCapability = 'llm' | 'vision' | 'text2img' | 'img2img' | 'i2v';

/**
 * Default providers configuration (by capability)
 */
export interface DefaultProvidersConfig {
  llm?: AIProviderType; // Default LLM provider name
  vision?: AIProviderType; // Default vision/multimodal provider name
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
  text2img?: AIProviderType;
  img2img?: AIProviderType;
  i2v?: AIProviderType;
}

/**
 * Auto-switch configuration
 */
export interface AutoSwitchConfig {
  // Automatically switch to vision provider when message contains images
  // but current provider doesn't support vision
  enableVisionFallback?: boolean;
}

export interface AIConfig {
  // Default providers by capability
  defaultProviders?: DefaultProvidersConfig;
  // Provider configurations
  providers: Record<string, AIProviderConfig>;
  // Session-level provider overrides (key is sessionId)
  sessionProviders?: Record<string, SessionProviderConfig>;
  // Auto-switch configuration
  autoSwitch?: AutoSwitchConfig;
  /**
   * Use native tool/function calling for reply generation (single LLM call with tools).
   * When true (default), TaskSystem uses reply tool-use flow (ReplyGenerationService + replyTools); when false, uses legacy TaskAnalyzer + ReplyGenerationService.
   */
  useToolUse?: boolean;
  /**
   * Provider and model for lightweight/fast LLM calls (e.g. prefix-invitation, analysis).
   * If omitted, lite callers fall back to default LLM and no model override.
   */
  liteLlm?: { provider?: string; model?: string };
  /**
   * Provider and model for convert-to-card LLM call (cheap).
   * If omitted, convert-to-card uses default LLM and no model override.
   */
  convertLlm?: { provider?: string; model?: string };
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
  GeminiProviderConfig,
  GoogleCloudRunProviderConfig,
  LaozhangLLmConfig,
  LaozhangProviderConfig,
  LaozhangText2ImgConfig,
  LaozhangVisionConfig,
  LocalText2ImageProviderConfig,
  NovelAIProviderConfig,
  OllamaProviderConfig,
  OpenAIProviderConfig,
  OpenRouterProviderConfig,
  RunPodProviderConfig,
} from './providers';

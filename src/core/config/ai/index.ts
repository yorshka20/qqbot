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
  LaozhangProviderConfig,
  LocalText2ImageProviderConfig,
  NovelAIProviderConfig,
  OllamaProviderConfig,
  OpenAIProviderConfig,
  OpenRouterProviderConfig,
  RunPodProviderConfig
} from './providers';


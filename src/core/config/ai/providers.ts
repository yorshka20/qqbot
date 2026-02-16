// AI Provider configuration types

export type AIProviderType =
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'deepseek'
  | 'local-text2img'
  | 'runpod'
  | 'openrouter'
  | 'novelai'
  | 'gemini'
  | 'doubao'
  | 'laozhang';

export interface OpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  enableContext?: boolean; // Enable automatic context loading from conversation history
  contextMessageCount?: number; // Number of recent messages to load as context (default: 10)
}

export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  model?: string; // claude-3-opus, claude-3-sonnet, claude-3-haiku, etc.
  temperature?: number;
  maxTokens?: number;
  enableContext?: boolean; // Enable automatic context loading from conversation history
  contextMessageCount?: number; // Number of recent messages to load as context (default: 10)
  resourceSavePath?: string; // Directory path to save downloaded resources (e.g., './data/downloads/anthropic')
}

export interface OllamaProviderConfig {
  type: 'ollama';
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  enableContext?: boolean; // Enable automatic context loading from conversation history
  contextMessageCount?: number; // Number of recent messages to load as context (default: 10)
}

export interface DeepSeekProviderConfig {
  type: 'deepseek';
  apiKey: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  enableContext?: boolean; // Enable automatic context loading from conversation history
  contextMessageCount?: number; // Number of recent messages to load as context (default: 10)
}

export interface LocalText2ImageProviderConfig {
  type: 'local-text2img';
  baseUrl: string; // Base URL of the Python server (e.g., http://localhost:8000)
  endpoint?: string; // API endpoint path (default: /generate)
  timeout?: number; // Request timeout in milliseconds (default: 300000 = 5 minutes)
  censorEnabled?: boolean; // Enable content censorship (default: true)
  // Default values for image generation parameters
  defaultSteps?: number; // Default number of inference steps (default: 25)
  defaultWidth?: number; // Default image width (default: 1024)
  defaultHeight?: number; // Default image height (default: 1024)
  defaultGuidanceScale?: number; // Default guidance scale (default: 5)
  defaultNumImages?: number; // Default number of images to generate (default: 1)
}

export interface OpenRouterProviderConfig {
  type: 'openrouter';
  apiKey: string;
  model?: string; // e.g., "openai/gpt-4o", "anthropic/claude-3-opus"
  baseURL?: string; // Default: "https://openrouter.ai/api/v1"
  temperature?: number;
  maxTokens?: number;
  enableContext?: boolean; // Enable automatic context loading from conversation history
  contextMessageCount?: number; // Number of recent messages to load as context (default: 10)
  httpReferer?: string; // Optional: Site URL for rankings
  siteName?: string; // Optional: Site name for rankings
  resourceSavePath?: string; // Directory path to save downloaded resources (e.g., './data/downloads/openrouter')
}

export interface NovelAIProviderConfig {
  type: 'novelai';
  accessToken: string; // NovelAI access token
  baseURL?: string; // Default: "https://image.novelai.net" (api.novelai.net was deprecated on 2024-04-05)
  model?: string; // Model name: 'nai-diffusion-4-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-3' (default: 'nai-diffusion-4-5-curated')
  defaultSteps?: number; // Default inference steps
  defaultWidth?: number; // Default image width
  defaultHeight?: number; // Default image height
  defaultGuidanceScale?: number; // Default guidance scale
  defaultStrength?: number; // Default strength for img2img (0-1)
  defaultNoise?: number; // Default noise for img2img
  resourceSavePath?: string; // Directory path to save downloaded resources (e.g., './data/downloads/novelai')
}

export interface GeminiProviderConfig {
  type: 'gemini';
  apiKey: string;
  model?: string; // Default: 'gemini-2.5-flash-image'
  defaultWidth?: number;
  defaultHeight?: number;
  resourceSavePath?: string; // Directory path to save downloaded resources (e.g., './data/downloads/gemini')
}

export interface DoubaoProviderConfig {
  type: 'doubao';
  apiKey: string;
  model?: string; // Default: 'doubao-seed-1-6-lite-251015'
  baseURL?: string; // Default: 'https://ark.cn-beijing.volces.com/api/v3'
  reasoningEffort?: 'low' | 'medium' | 'high'; // Default: 'medium'
  temperature?: number;
  maxTokens?: number;
  enableContext?: boolean; // Enable automatic context loading from conversation history
  contextMessageCount?: number; // Number of recent messages to load as context (default: 10)
}

export interface LaozhangProviderConfig {
  type: 'laozhang';
  apiKey: string;
  model?: string; // Default: 'gemini-3-pro-image-preview'
  baseURL?: string; // Default: 'https://api.laozhang.ai'
  defaultAspectRatio?: string; // One of: "1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "3:2", "2:3", "5:4", "4:5", default: "16:9"
  defaultImageSize?: string; // One of: "1K", "2K", "4K", default: "2K"
  resourceSavePath?: string; // Directory path to save downloaded resources (e.g., './data/downloads/laozhang')
}

/** RunPod Serverless provider (T2I + I2V). Same pattern as other providers: all config in ai.providers.runpod. */
export interface RunPodProviderConfig {
  type: 'runpod';
  endpointId: string;
  apiKey: string;
  /** Optional T2I-only endpoint; if not set, endpointId is used for T2I */
  t2iEndpointId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type AIProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | OllamaProviderConfig
  | DeepSeekProviderConfig
  | LocalText2ImageProviderConfig
  | OpenRouterProviderConfig
  | NovelAIProviderConfig
  | GeminiProviderConfig
  | DoubaoProviderConfig
  | LaozhangProviderConfig
  | RunPodProviderConfig;

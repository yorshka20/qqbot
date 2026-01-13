// AI Provider configuration types

export type AIProviderType =
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'deepseek'
  | 'local-text2img'
  | 'openrouter'
  | 'novelai';

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
  baseURL?: string; // Default: "https://api.novelai.net"
  defaultSteps?: number; // Default inference steps
  defaultWidth?: number; // Default image width
  defaultHeight?: number; // Default image height
  defaultGuidanceScale?: number; // Default guidance scale
  defaultStrength?: number; // Default strength for img2img (0-1)
  defaultNoise?: number; // Default noise for img2img
  resourceSavePath?: string; // Directory path to save downloaded resources (e.g., './data/downloads/novelai')
}

export type AIProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | OllamaProviderConfig
  | DeepSeekProviderConfig
  | LocalText2ImageProviderConfig
  | OpenRouterProviderConfig
  | NovelAIProviderConfig;

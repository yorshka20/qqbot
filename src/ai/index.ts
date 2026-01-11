// AI module exports

export { AIProvider } from './base/AIProvider';
export { OpenAIProvider } from './providers/OpenAIProvider';
export { OllamaProvider } from './providers/OllamaProvider';
export { AIManager } from './AIManager';
export { AIService } from './AIService';
export { PromptManager } from './PromptManager';
export type {
  AIGenerateOptions,
  AIGenerateResponse,
  StreamingHandler,
} from './types';
export type { PromptTemplate, SystemPrompt } from './prompt-types';

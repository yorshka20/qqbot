// LLM Capability interface - text generation capability

import type { AIProvider } from '../base/AIProvider';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';

/**
 * LLM Capability interface
 * Providers that support text generation should implement this interface
 */
export interface LLMCapability {
  /**
   * Generate text from prompt
   */
  generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse>;

  /**
   * Generate text with streaming support
   */
  generateStream(prompt: string, handler: StreamingHandler, options?: AIGenerateOptions): Promise<AIGenerateResponse>;
}

/**
 * LLM Capability interface
 * Providers that support text generation should implement this interface
 */
export interface LLMCapability {
  /**
   * Generate text from prompt
   */
  generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse>;

  /**
   * Generate text with streaming support
   */
  generateStream(prompt: string, handler: StreamingHandler, options?: AIGenerateOptions): Promise<AIGenerateResponse>;
}

/**
 * Type guard to check if a provider implements LLMCapability
 * Checks if provider explicitly declared 'llm' capability in getCapabilities()
 */
export function isLLMCapability(provider: unknown): provider is LLMCapability {
  if (typeof provider !== 'object' || provider === null) {
    return false;
  }

  // All providers extend AIProvider which has getCapabilities() method
  // Check if provider explicitly declared 'llm' capability
  const aiProvider = provider as AIProvider;
  const capabilities = aiProvider.getCapabilities();
  return Array.isArray(capabilities) && capabilities.includes('llm');
}

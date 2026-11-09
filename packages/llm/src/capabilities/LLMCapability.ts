// LLM Capability interface - text generation capability

import type { AIProvider } from '../base/AIProvider';
import type { ConcreteLLMTarget, LLMTarget } from '../config';
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

  /**
   * Optional: lightweight generation (e.g. via Chat API for Doubao) for cheap/fast tasks.
   * When not implemented, LLMService falls back to generate() with lite options.
   */
  generateLite?(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse>;

  /** The concrete model a call runs on when the caller names none. */
  getDefaultModel(): string;
}

/** `target` made concrete on `provider`: an unnamed model is the provider's own default. */
export function concreteLLMTarget(provider: LLMCapability, target: LLMTarget): ConcreteLLMTarget {
  return { provider: target.provider, model: target.model ?? provider.getDefaultModel() };
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

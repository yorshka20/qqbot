// LLM Service - provides LLM text generation capability

import type { AIManager } from '../AIManager';
import type { LLMCapability } from '../capabilities/LLMCapability';
import { isLLMCapability } from '../capabilities/LLMCapability';
import type { ProviderSelector } from '../ProviderSelector';
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';

/**
 * LLM Service
 * Provides LLM text generation capability
 */
export class LLMService {
  constructor(
    private aiManager: AIManager,
    private providerSelector?: ProviderSelector,
  ) {}

  /**
   * Generate text using LLM capability
   */
  async generate(prompt: string, options?: AIGenerateOptions, providerName?: string): Promise<AIGenerateResponse> {
    // Determine which provider to use
    let provider: LLMCapability | null = null;
    const sessionId = options?.sessionId;

    if (providerName) {
      // Use specified provider
      const p = this.aiManager.getProviderForCapability('llm', providerName);
      if (p && isLLMCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support LLM capability`);
      }
    } else if (sessionId && this.providerSelector) {
      // Use session-specific provider
      const sessionProviderName = this.providerSelector.getProviderForSession(sessionId, 'llm');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('llm', sessionProviderName);
        if (p && isLLMCapability(p)) {
          provider = p;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('llm');
      if (defaultProvider && isLLMCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No LLM provider available');
      }
    }

    return await provider.generate(prompt, options);
  }

  /**
   * Generate text with streaming
   */
  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    // Determine which provider to use
    let provider: LLMCapability | null = null;
    const sessionId = options?.sessionId;

    if (providerName) {
      const p = this.aiManager.getProviderForCapability('llm', providerName);
      if (p && isLLMCapability(p)) {
        provider = p;
      } else {
        throw new Error(`Provider ${providerName} does not support LLM capability`);
      }
    } else if (sessionId && this.providerSelector) {
      const sessionProviderName = this.providerSelector.getProviderForSession(sessionId, 'llm');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('llm', sessionProviderName);
        if (p && isLLMCapability(p)) {
          provider = p;
        }
      }
    }

    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('llm');
      if (defaultProvider && isLLMCapability(defaultProvider)) {
        provider = defaultProvider;
      } else {
        throw new Error('No LLM provider available');
      }
    }

    return await provider.generateStream(prompt, handler, options);
  }
}

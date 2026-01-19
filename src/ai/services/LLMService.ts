// LLM Service - provides LLM text generation capability

import { logger } from '@/utils/logger';
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
  ) { }

  /**
   * Get fallback response when no provider is available
   * Returns a simple template response based on the prompt type
   */
  private getFallbackResponse(prompt: string): AIGenerateResponse {
    // Check if this is a summary request
    if (prompt.includes('Summarize') || prompt.includes('Summary:')) {
      // Extract conversation text if possible
      const conversationMatch = prompt.match(/User:.*?Assistant:.*/s);
      if (conversationMatch) {
        const conversationText = conversationMatch[0];
        // Create a simple summary based on message count
        const messages = conversationText.split(/\n(?=User:|Assistant:)/).filter(Boolean);
        return {
          text: `Previous conversation with ${messages.length} messages. Key topics discussed.`,
        };
      }
      return {
        text: 'Previous conversation summary: Key topics and decisions were discussed.',
      };
    }

    // Default fallback response
    return {
      text: 'I apologize, but AI service is currently unavailable. Please try again later.',
    };
  }

  /**
   * Check if provider is available
   */
  private async getAvailableProvider(providerName?: string, sessionId?: string): Promise<LLMCapability | null> {
    let provider: LLMCapability | null = null;

    if (providerName) {
      // Use specified provider
      const p = this.aiManager.getProviderForCapability('llm', providerName);
      if (p && isLLMCapability(p) && p.isAvailable()) {
        provider = p;
      }
    } else if (sessionId && this.providerSelector) {
      // Use session-specific provider
      const sessionProviderName = await this.providerSelector.getProviderForSession(sessionId, 'llm');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('llm', sessionProviderName);
        if (p && isLLMCapability(p) && p.isAvailable()) {
          provider = p;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('llm');
      if (defaultProvider && isLLMCapability(defaultProvider) && defaultProvider.isAvailable()) {
        provider = defaultProvider;
      }
    }

    return provider;
  }

  /**
   * Generate text using LLM capability
   */
  async generate(prompt: string, options?: AIGenerateOptions, providerName?: string): Promise<AIGenerateResponse> {
    const sessionId = options?.sessionId;
    const provider = await this.getAvailableProvider(providerName, sessionId);

    // If no available provider, return fallback response
    if (!provider) {
      logger.warn('[LLMService] No available LLM provider, returning fallback response');
      return this.getFallbackResponse(prompt);
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
    const sessionId = options?.sessionId;
    const provider = await this.getAvailableProvider(providerName, sessionId);

    // If no available provider, return fallback response
    if (!provider) {
      logger.warn('[LLMService] No available LLM provider, returning fallback response');
      const fallbackResponse = this.getFallbackResponse(prompt);
      // Call handler with fallback text for streaming compatibility
      handler(fallbackResponse.text);
      return fallbackResponse;
    }

    return await provider.generateStream(prompt, handler, options);
  }
}

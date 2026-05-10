// AI Provider abstract base class

import type { ContextManager } from '@/context/ContextManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { CapabilityType } from '../capabilities/types';
import type { AIGenerateOptions, ConversationMessage } from '../types';

/**
 * Abstract AI Provider interface
 * All AI providers must implement this interface
 */
export abstract class AIProvider {
  /**
   * Provider name/identifier
   */
  abstract readonly name: string;

  /**
   * Whether this provider supports tool/function calling.
   * Override to `true` in providers that implement tool use in their generate() method.
   */
  readonly supportsToolUse: boolean = false;

  /**
   * Whether this provider is a relay/proxy (can switch models and actual upstream providers).
   * Examples: openrouter, laozhang, ollama, groq.
   */
  readonly isRelay: boolean = false;

  /**
   * Whether to skip health checks for this provider.
   * Serverless providers (e.g. runpod, google-cloud-run) should set this to true
   * to avoid cold-start invocations from health check pings.
   */
  readonly skipHealthCheck: boolean = false;

  /**
   * Whether context is enabled for this provider
   */
  protected enableContext: boolean = false;

  /**
   * Number of recent messages to load as context
   */
  protected contextMessageCount: number = 10;

  /**
   * Get context manager from DI container. CONTEXT_MANAGER is a required
   * token (DITokens.ts); this just sugars the resolve call.
   */
  protected getContextManager(): ContextManager {
    return getContainer().resolve<ContextManager>(DITokens.CONTEXT_MANAGER);
  }

  /**
   * Set context configuration
   */
  setContextConfig(enableContext: boolean, contextMessageCount: number = 10): void {
    this.enableContext = enableContext;
    this.contextMessageCount = contextMessageCount;
  }

  /**
   * Load conversation history automatically if context is enabled
   */
  protected async loadHistory(options?: AIGenerateOptions): Promise<ConversationMessage[]> {
    if (!this.enableContext || !options?.sessionId) {
      return [];
    }

    const contextManager = this.getContextManager();

    try {
      const history = contextManager.getHistory(options.sessionId, this.contextMessageCount);

      // Convert to ConversationMessage format
      return history.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AIProvider] Failed to load conversation history:', err);
      return [];
    }
  }

  /**
   * Check if provider is available/configured
   * This is a synchronous check that only verifies configuration
   */
  abstract isAvailable(): boolean;

  /**
   * Check if provider is actually available (async check)
   * This performs an actual connection test to verify the provider is reachable
   * Should be implemented by all providers to test actual connectivity
   */
  abstract checkAvailability(): Promise<boolean>;

  /**
   * Get provider configuration
   */
  abstract getConfig(): Record<string, unknown>;

  /**
   * Get capabilities supported by this provider
   * Providers must explicitly declare which capabilities they support
   * This method should return an array of capability types that this provider implements
   *
   * Example:
   *   return ['llm', 'vision']; // Provider supports LLM and Vision
   */
  abstract getCapabilities(): CapabilityType[];

  /**
   * Check if provider supports a specific capability
   */
  supportsCapability(capability: CapabilityType): boolean {
    return this.getCapabilities().includes(capability);
  }
}

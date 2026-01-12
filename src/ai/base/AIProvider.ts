// AI Provider abstract base class

import type { ContextManager } from '@/context/ContextManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
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
   * Whether context is enabled for this provider
   */
  protected enableContext: boolean = false;

  /**
   * Number of recent messages to load as context
   */
  protected contextMessageCount: number = 10;

  /**
   * Get context manager from DI container
   */
  protected getContextManager(): ContextManager | null {
    const container = getContainer();
    if (container.isRegistered(DITokens.CONTEXT_MANAGER)) {
      return container.resolve<ContextManager>(DITokens.CONTEXT_MANAGER);
    }
    return null;
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
    if (!contextManager) {
      return [];
    }

    try {
      const history = contextManager.getHistory(options.sessionId, this.contextMessageCount);

      // Convert to ConversationMessage format
      return history.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
    } catch (error) {
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

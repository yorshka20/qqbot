// Provider Selector - manages session-level provider selection

import type { ConversationConfigService } from '@/config/ConversationConfigService';
import type { ProviderSelection } from '@/database/models/types';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import type { CapabilityType } from './capabilities/types';

/**
 * Provider selection for a session (alias for ProviderSelection)
 */
export interface SessionProviderSelection extends ProviderSelection { }

/**
 * Provider Selector
 * Manages provider selection at the session level (based on sessionId)
 * Persists to conversation_configs table via ConversationConfigService
 */
export class ProviderSelector {
  // In-memory cache of session provider selections
  private sessionSelections = new Map<string, SessionProviderSelection>();

  constructor(
    private aiManager: AIManager,
    private configService: ConversationConfigService,
  ) { }

  /**
   * Parse sessionId to extract sessionId and sessionType
   * Supports formats: "group:123", "user:456", "group_123", "user_456", or just "123" (defaults to user)
   */
  private parseSessionId(sessionId: string): { sessionId: string; sessionType: 'user' | 'group' } {
    // Check for colon format: "group:123" or "user:456"
    if (sessionId.startsWith('group:')) {
      return {
        sessionId: sessionId.substring(6),
        sessionType: 'group',
      };
    }
    if (sessionId.startsWith('user:')) {
      return {
        sessionId: sessionId.substring(5),
        sessionType: 'user',
      };
    }
    // Check for underscore format: "group_123" or "user_456"
    if (sessionId.startsWith('group_')) {
      return {
        sessionId: sessionId.substring(6),
        sessionType: 'group',
      };
    }
    if (sessionId.startsWith('user_')) {
      return {
        sessionId: sessionId.substring(5),
        sessionType: 'user',
      };
    }
    // Default to user if no prefix
    return {
      sessionId,
      sessionType: 'user',
    };
  }

  /**
   * Load provider selection from conversation config
   */
  private async loadProviderSelection(sessionId: string): Promise<void> {
    try {
      const { sessionId: parsedId, sessionType } = this.parseSessionId(sessionId);
      const config = await this.configService.getConfig(parsedId, sessionType);

      if (config.providers) {
        this.sessionSelections.set(sessionId, config.providers);
        logger.debug(`[ProviderSelector] Loaded provider selection for session ${sessionId}`);
      }
    } catch (error) {
      logger.warn(`[ProviderSelector] Failed to load provider selection for ${sessionId}:`, error);
    }
  }

  /**
   * Get provider for a capability for a specific session
   * Returns session-specific provider if set, otherwise returns default provider
   */
  async getProviderForSession(sessionId: string, capability: CapabilityType): Promise<string | null> {
    // Load from config if not in cache
    if (!this.sessionSelections.has(sessionId)) {
      await this.loadProviderSelection(sessionId);
    }

    // Check session-specific selection
    const sessionSelection = this.sessionSelections.get(sessionId);
    if (sessionSelection) {
      const providerName = sessionSelection[capability];
      if (providerName) {
        // Verify provider exists and supports the capability
        const provider = this.aiManager.getProviderForCapability(capability, providerName);
        if (provider) {
          return providerName;
        }
        // Provider not found or doesn't support capability, fall back to default
        logger.warn(
          `[ProviderSelector] Session ${sessionId} provider ${providerName} for ${capability} not available, using default`,
        );
      }
    }

    // Fall back to default provider
    const defaultProvider = this.aiManager.getDefaultProvider(capability);
    return defaultProvider ? defaultProvider.name : null;
  }

  /**
   * Set provider for a capability for a specific session
   */
  async setProviderForSession(sessionId: string, capability: CapabilityType, providerName: string): Promise<void> {
    // Verify provider exists and supports the capability
    const provider = this.aiManager.getProviderForCapability(capability, providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} does not support capability ${capability} or is not available`);
    }

    // Load existing selection if not in cache
    if (!this.sessionSelections.has(sessionId)) {
      await this.loadProviderSelection(sessionId);
    }

    // Update in-memory cache
    let sessionSelection = this.sessionSelections.get(sessionId);
    if (!sessionSelection) {
      sessionSelection = {};
      this.sessionSelections.set(sessionId, sessionSelection);
    }
    sessionSelection[capability] = providerName;

    // Persist to conversation config
    const { sessionId: parsedId, sessionType } = this.parseSessionId(sessionId);
    await this.configService.updateConfig(parsedId, sessionType, {
      providers: sessionSelection,
    });

    logger.info(`[ProviderSelector] Set provider ${providerName} for ${capability} for session ${sessionId}`);
  }

  /**
   * Get all provider selections for a session
   */
  async getSessionSelection(sessionId: string): Promise<SessionProviderSelection | null> {
    // Load from config if not in cache
    if (!this.sessionSelections.has(sessionId)) {
      await this.loadProviderSelection(sessionId);
    }
    return this.sessionSelections.get(sessionId) || null;
  }

  /**
   * Set all provider selections for a session
   */
  async setSessionSelection(sessionId: string, selection: SessionProviderSelection): Promise<void> {
    // Validate all providers
    for (const [capability, providerName] of Object.entries(selection)) {
      if (providerName) {
        const provider = this.aiManager.getProviderForCapability(capability as CapabilityType, providerName);
        if (!provider) {
          throw new Error(`Provider ${providerName} does not support capability ${capability} or is not available`);
        }
      }
    }

    // Update in-memory cache
    this.sessionSelections.set(sessionId, selection);

    // Persist to conversation config
    const { sessionId: parsedId, sessionType } = this.parseSessionId(sessionId);
    await this.configService.updateConfig(parsedId, sessionType, {
      providers: selection,
    });

    logger.info(`[ProviderSelector] Set provider selection for session ${sessionId}`);
  }

  /**
   * Clear session selection (reset to defaults)
   */
  async clearSessionSelection(sessionId: string): Promise<void> {
    this.sessionSelections.delete(sessionId);

    // Remove from conversation config
    const { sessionId: parsedId, sessionType } = this.parseSessionId(sessionId);
    await this.configService.updateConfig(parsedId, sessionType, {
      providers: undefined,
    });

    logger.info(`[ProviderSelector] Cleared provider selection for session ${sessionId}`);
  }
}

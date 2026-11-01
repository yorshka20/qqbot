// Provider Selector - manages session-level provider selection

import { inject, singleton } from 'tsyringe';
import { ConversationConfigService } from '@/conversation/ConversationConfigService';
import { DITokens } from '@/core/DITokens';
import type { ProviderSelection } from '@/database/models/types';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import type { CapabilityType } from './capabilities/types';

/**
 * Provider selection for a session (alias for ProviderSelection)
 */
export interface SessionProviderSelection extends ProviderSelection {}

/**
 * Provider Selector
 * Manages provider selection at the session level (based on sessionId)
 * Persists to conversation_configs table via ConversationConfigService
 */
@singleton()
export class ProviderSelector {
  // In-memory cache of session provider selections
  private sessionSelections = new Map<string, SessionProviderSelection>();

  constructor(
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
    @inject(ConversationConfigService) private configService: ConversationConfigService,
  ) {}

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
   * The session's own selection for a capability, or null when it has none or names a
   * provider that is no longer available. The default is not consulted: a caller that
   * finds no override falls back to the default itself, so the two stay distinguishable.
   */
  async getSessionOverride<C extends SelectableCapability>(
    sessionId: string,
    capability: C,
  ): Promise<ProviderSelection[C] | null> {
    const selection = await this.loadCachedSelection(sessionId);
    const value = selection?.[capability];
    if (!value) {
      return null;
    }
    const providerName = selectionProviderName(value);
    if (!this.aiManager.getProviderForCapability(capability, providerName)) {
      logger.warn(
        `[ProviderSelector] Session ${sessionId} provider ${providerName} for ${capability} not available, using default`,
      );
      return null;
    }
    return value;
  }

  async setSessionOverride<C extends SelectableCapability>(
    sessionId: string,
    capability: C,
    value: NonNullable<ProviderSelection[C]>,
  ): Promise<void> {
    const providerName = selectionProviderName(value);
    if (!this.aiManager.getProviderForCapability(capability, providerName)) {
      throw new Error(`Provider ${providerName} does not support capability ${capability} or is not available`);
    }
    const selection = (await this.loadCachedSelection(sessionId)) ?? {};
    selection[capability] = value;
    await this.persistSelection(sessionId, selection);
    logger.info(`[ProviderSelector] Set ${capability} override for session ${sessionId}: ${JSON.stringify(value)}`);
  }

  async clearSessionOverride(sessionId: string, capability: SelectableCapability): Promise<void> {
    const selection = await this.loadCachedSelection(sessionId);
    if (!selection?.[capability]) {
      return;
    }
    delete selection[capability];
    await this.persistSelection(sessionId, selection);
    logger.info(`[ProviderSelector] Cleared ${capability} override for session ${sessionId}`);
  }

  private async loadCachedSelection(sessionId: string): Promise<SessionProviderSelection | undefined> {
    if (!this.sessionSelections.has(sessionId)) {
      await this.loadProviderSelection(sessionId);
    }
    return this.sessionSelections.get(sessionId);
  }

  private async persistSelection(sessionId: string, selection: SessionProviderSelection): Promise<void> {
    this.sessionSelections.set(sessionId, selection);
    const { sessionId: parsedId, sessionType } = this.parseSessionId(sessionId);
    await this.configService.updateConfig(parsedId, sessionType, {
      providers: selection,
    });
  }
}

/** Capabilities a session can override: those with a slot in the persisted selection. */
export type SelectableCapability = CapabilityType & keyof ProviderSelection;

function selectionProviderName(value: NonNullable<ProviderSelection[SelectableCapability]>): string {
  return typeof value === 'string' ? value : value.provider;
}

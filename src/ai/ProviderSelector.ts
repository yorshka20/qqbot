// Provider Selector - manages session-level provider selection

import type { DatabaseManager } from '@/database/DatabaseManager';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import type { CapabilityType } from './capabilities/types';

/**
 * Provider selection for a session
 */
export interface SessionProviderSelection {
  llm?: string;
  vision?: string;
  text2img?: string;
  img2img?: string;
}

/**
 * Provider Selector
 * Manages provider selection at the session level (based on sessionId)
 * Supports persistence to Session model's context field
 */
export class ProviderSelector {
  // In-memory cache of session provider selections
  private sessionSelections = new Map<string, SessionProviderSelection>();

  constructor(
    private aiManager: AIManager,
    private databaseManager: DatabaseManager,
  ) {}

  /**
   * Get provider for a capability for a specific session
   * Returns session-specific provider if set, otherwise returns default provider
   */
  getProviderForSession(sessionId: string, capability: CapabilityType): string | null {
    // Check session-specific selection first
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

    // Update in-memory cache
    let sessionSelection = this.sessionSelections.get(sessionId);
    if (!sessionSelection) {
      sessionSelection = {};
      this.sessionSelections.set(sessionId, sessionSelection);
    }
    sessionSelection[capability] = providerName;

    // Persist to database
    await this.persistSessionSelection(sessionId, sessionSelection);

    logger.info(`[ProviderSelector] Set provider ${providerName} for ${capability} for session ${sessionId}`);
  }

  /**
   * Get all provider selections for a session
   */
  getSessionSelection(sessionId: string): SessionProviderSelection | null {
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

    // Persist to database
    await this.persistSessionSelection(sessionId, selection);

    logger.info(`[ProviderSelector] Set provider selection for session ${sessionId}`);
  }

  /**
   * Load session selection from database
   */
  async loadSessionSelection(sessionId: string): Promise<void> {
    try {
      const adapter = this.databaseManager.getAdapter();
      const sessions = adapter.getModel('sessions');
      const session = await sessions.findOne({ sessionId });

      if (session && session.context) {
        const providerSelection = (session.context as Record<string, unknown>).providerSelection as
          | SessionProviderSelection
          | undefined;

        if (providerSelection) {
          this.sessionSelections.set(sessionId, providerSelection);
          logger.debug(`[ProviderSelector] Loaded provider selection for session ${sessionId}`);
        }
      }
    } catch (error) {
      logger.warn(`[ProviderSelector] Failed to load session selection for ${sessionId}:`, error);
    }
  }

  /**
   * Persist session selection to database
   */
  private async persistSessionSelection(sessionId: string, selection: SessionProviderSelection): Promise<void> {
    try {
      const adapter = this.databaseManager.getAdapter();
      const sessions = adapter.getModel('sessions');
      const session = await sessions.findOne({ sessionId });

      if (session) {
        // Update existing session
        const context = (session.context as Record<string, unknown>) || {};
        context.providerSelection = selection;
        await sessions.update(session.id, { context });
      } else {
        // Create new session record
        // Extract sessionType from sessionId (assuming format: "user:123" or "group:456")
        // For now, we'll default to 'user' if we can't determine
        const sessionType = sessionId.startsWith('group:') ? 'group' : 'user';
        await sessions.create({
          sessionId,
          sessionType,
          context: {
            providerSelection: selection,
          },
        });
      }

      logger.debug(`[ProviderSelector] Persisted provider selection for session ${sessionId}`);
    } catch (error) {
      logger.warn(`[ProviderSelector] Failed to persist session selection for ${sessionId}:`, error);
    }
  }

  /**
   * Clear session selection (reset to defaults)
   */
  async clearSessionSelection(sessionId: string): Promise<void> {
    this.sessionSelections.delete(sessionId);

    try {
      const adapter = this.databaseManager.getAdapter();
      const sessions = adapter.getModel('sessions');
      const session = await sessions.findOne({ sessionId });

      if (session && session.context) {
        const context = session.context as Record<string, unknown>;
        delete context.providerSelection;
        await sessions.update(session.id, { context });
      }
    } catch (error) {
      logger.warn(`[ProviderSelector] Failed to clear session selection for ${sessionId}:`, error);
    }

    logger.info(`[ProviderSelector] Cleared provider selection for session ${sessionId}`);
  }
}

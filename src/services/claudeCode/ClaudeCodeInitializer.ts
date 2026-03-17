/**
 * Claude Code Service Initializer
 *
 * Handles initialization and lifecycle management of the Claude Code service.
 */

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { APIClient } from '@/api/APIClient';
import type { Config, ProtocolName } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { ClaudeCodeService } from './ClaudeCodeService';

let serviceInstance: ClaudeCodeService | null = null;

export class ClaudeCodeInitializer {
  /**
   * Initialize the Claude Code service if enabled in config
   */
  static initialize(config: Config): ClaudeCodeService | null {
    const claudeConfig = config.getClaudeCodeServiceConfig();

    if (!claudeConfig?.enabled) {
      logger.debug('[ClaudeCodeInitializer] Claude Code service is disabled');
      return null;
    }

    serviceInstance = new ClaudeCodeService(claudeConfig);

    // Register in DI container
    const container = getContainer();
    container.registerInstance(DITokens.CLAUDE_CODE_SERVICE, serviceInstance);

    logger.info('[ClaudeCodeInitializer] Claude Code service initialized');
    return serviceInstance;
  }

  /**
   * Start the Claude Code service
   */
  static async start(service: ClaudeCodeService | null, apiClient: APIClient): Promise<void> {
    if (!service) {
      return;
    }

    service.setAPIClient(apiClient);

    // Set PromptManager from DI container
    try {
      const container = getContainer();
      const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
      service.setPromptManager(promptManager);
    } catch (error) {
      logger.warn('[ClaudeCodeInitializer] Failed to get PromptManager:', error);
    }

    await service.start();
  }

  /**
   * Update bot info in the service
   */
  static updateBotInfo(service: ClaudeCodeService | null, selfId: string | null, protocols: ProtocolName[]): void {
    if (service) {
      service.updateBotInfo(selfId, protocols);
    }
  }

  /**
   * Stop the Claude Code service
   */
  static async stop(service: ClaudeCodeService | null): Promise<void> {
    if (service) {
      await service.stop();
    }
  }

  /**
   * Get the service instance from DI container
   */
  static getService(): ClaudeCodeService | null {
    try {
      const container = getContainer();
      return container.resolve<ClaudeCodeService>(DITokens.CLAUDE_CODE_SERVICE);
    } catch {
      return null;
    }
  }
}

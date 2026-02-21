// Prompt Initializer - initializes PromptManager and registers it to DI container

import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { resolve } from 'path';
import { PromptManager } from './PromptManager';

export interface PromptSystem {
  promptManager: PromptManager;
}

/**
 * Prompt Initializer
 * Initializes PromptManager and registers it to DI container
 */
export class PromptInitializer {
  /**
   * Initialize prompt system
   * @param config - Bot configuration
   * @returns Initialized prompt system
   */
  static initialize(config: Config): PromptSystem {
    logger.info('[PromptInitializer] Starting initialization...');

    // Load prompt templates early (before conversation initialization)
    // PromptManager has no dependencies and can be loaded independently
    const promptsConfig = config.getPromptsConfig();
    if (!promptsConfig) {
      throw new Error('Prompts configuration is required. Please set "prompts.directory" in config file.');
    }

    const promptDirectory = resolve(process.cwd(), promptsConfig.directory);
    const adminUserId = config.getConfig().bot.owner;
    const promptManager = new PromptManager(promptDirectory, adminUserId);

    // Always auto-load templates from directory
    promptManager.loadTemplatesFromDirectory();
    logger.info(`[PromptInitializer] PromptManager initialized and templates loaded from: ${promptDirectory}`);

    // Register PromptManager to DI container early (before conversation initialization)
    const container = getContainer();
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager);
    logger.debug('[PromptInitializer] PromptManager registered to DI container');

    return {
      promptManager,
    };
  }
}

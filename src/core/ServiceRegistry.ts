// Service Registry - manages service registration to DI container
// Provides a clear, organized way to register services with proper lifecycle management

import type { AIManager } from '@/ai/AIManager';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/PromptManager';
import type { APIClient } from '@/api/APIClient';
import type { CommandManager } from '@/command/CommandManager';
import type { ContextManager } from '@/context/ContextManager';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { TaskManager } from '@/task/TaskManager';
import { logger } from '@/utils/logger';
import type { Config } from './Config';
import { getContainer } from './DIContainer';
import { DITokens } from './DITokens';

/**
 * Service Registry
 * Manages registration of services to the DI container
 * Provides clear separation of concerns for service registration
 */
export class ServiceRegistry {
  private container = getContainer();

  /**
   * Register core infrastructure services
   * These are services that don't depend on other conversation services
   */
  registerInfrastructureServices(config: Config, apiClient: APIClient): void {
    // Register config and API client first (they're needed by many services)
    this.container.registerInstance(DITokens.CONFIG, config, {
      logRegistration: false,
    });
    this.container.registerInstance(DITokens.API_CLIENT, apiClient, {
      logRegistration: false,
    });
  }

  /**
   * Register database service
   */
  registerDatabaseService(databaseManager: DatabaseManager): void {
    this.container.registerInstance(DITokens.DATABASE_MANAGER, databaseManager);
  }

  /**
   * Register AI service
   */
  registerAIService(aiManager: AIManager): void {
    this.container.registerInstance(DITokens.AI_MANAGER, aiManager);
  }

  /**
   * Register AI Service (high-level AI capabilities)
   */
  registerAIServiceCapabilities(aiService: AIService): void {
    this.container.registerInstance(DITokens.AI_SERVICE, aiService);
  }

  /**
   * Register context service
   */
  registerContextService(contextManager: ContextManager): void {
    this.container.registerInstance(DITokens.CONTEXT_MANAGER, contextManager);
  }

  /**
   * Register command service
   * Note: CommandManager registers itself in constructor, but we can also register it here for consistency
   */
  registerCommandService(commandManager: CommandManager): void {
    this.container.registerInstance(DITokens.COMMAND_MANAGER, commandManager);
  }

  /**
   * Register task service
   */
  registerTaskService(taskManager: TaskManager): void {
    this.container.registerInstance(DITokens.TASK_MANAGER, taskManager);
  }

  /**
   * Register hook service
   */
  registerHookService(hookManager: HookManager): void {
    this.container.registerInstance(DITokens.HOOK_MANAGER, hookManager);
  }

  /**
   * Register prompt manager service
   */
  registerPromptManager(promptManager: PromptManager): void {
    this.container.registerInstance(DITokens.PROMPT_MANAGER, promptManager);
  }

  /**
   * Register all conversation services at once
   * Convenience method for batch registration
   */
  registerConversationServices(services: {
    databaseManager: DatabaseManager;
    aiManager: AIManager;
    contextManager: ContextManager;
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }): void {
    this.registerDatabaseService(services.databaseManager);
    this.registerAIService(services.aiManager);
    this.registerContextService(services.contextManager);
    this.registerCommandService(services.commandManager);
    this.registerTaskService(services.taskManager);
    this.registerHookService(services.hookManager);
  }

  /**
   * Verify all required services are registered
   */
  verifyServices(): boolean {
    const requiredTokens = Object.values(DITokens);

    const missing: string[] = [];
    for (const token of requiredTokens) {
      if (!this.container.isRegistered(token)) {
        missing.push(token);
      }
    }

    if (missing.length > 0) {
      logger.warn(`[ServiceRegistry] Missing required services: ${missing.join(', ')}`);
      return false;
    }

    logger.debug('[ServiceRegistry] All required services are registered');
    return true;
  }
}

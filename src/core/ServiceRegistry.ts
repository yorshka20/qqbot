// Service Registry - manages service registration to DI container
// Provides a clear, organized way to register services with proper lifecycle management

import type { AIManager } from '@/ai/AIManager';
import type { APIClient } from '@/api/APIClient';
import type { CommandManager } from '@/command/CommandManager';
import type { ContextManager } from '@/context/ContextManager';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/plugins/HookManager';
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
    logger.debug('[ServiceRegistry] Registering infrastructure services...');

    // Register config and API client first (they're needed by many services)
    this.container.registerInstance(DITokens.CONFIG, config, {
      logRegistration: false,
    });
    this.container.registerInstance(DITokens.API_CLIENT, apiClient, {
      logRegistration: false,
    });

    logger.debug('[ServiceRegistry] Infrastructure services registered');
  }

  /**
   * Register database service
   */
  registerDatabaseService(databaseManager: DatabaseManager): void {
    logger.debug('[ServiceRegistry] Registering database service...');
    this.container.registerInstance(DITokens.DATABASE_MANAGER, databaseManager);
  }

  /**
   * Register AI service
   */
  registerAIService(aiManager: AIManager): void {
    logger.debug('[ServiceRegistry] Registering AI service...');
    this.container.registerInstance(DITokens.AI_MANAGER, aiManager);
  }

  /**
   * Register context service
   */
  registerContextService(contextManager: ContextManager): void {
    logger.debug('[ServiceRegistry] Registering context service...');
    this.container.registerInstance(DITokens.CONTEXT_MANAGER, contextManager);
  }

  /**
   * Register command service
   * Note: CommandManager registers itself in constructor, but we can also register it here for consistency
   */
  registerCommandService(commandManager: CommandManager): void {
    logger.debug('[ServiceRegistry] Registering command service...');
    // CommandManager already registers itself, but we ensure it's registered
    if (!this.container.isRegistered(DITokens.COMMAND_MANAGER)) {
      this.container.registerInstance(DITokens.COMMAND_MANAGER, commandManager);
    }
  }

  /**
   * Register task service
   */
  registerTaskService(taskManager: TaskManager): void {
    logger.debug('[ServiceRegistry] Registering task service...');
    this.container.registerInstance(DITokens.TASK_MANAGER, taskManager);
  }

  /**
   * Register hook service
   */
  registerHookService(hookManager: HookManager): void {
    logger.debug('[ServiceRegistry] Registering hook service...');
    this.container.registerInstance(DITokens.HOOK_MANAGER, hookManager);
  }

  /**
   * Register all conversation services at once
   * Convenience method for batch registration
   */
  registerConversationServices(services: {
    databaseManager?: DatabaseManager;
    aiManager: AIManager;
    contextManager: ContextManager;
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }): void {
    logger.debug('[ServiceRegistry] Registering conversation services...');

    if (services.databaseManager) {
      this.registerDatabaseService(services.databaseManager);
    }
    this.registerAIService(services.aiManager);
    this.registerContextService(services.contextManager);
    this.registerCommandService(services.commandManager);
    this.registerTaskService(services.taskManager);
    this.registerHookService(services.hookManager);

    logger.debug('[ServiceRegistry] All conversation services registered');
  }

  /**
   * Verify all required services are registered
   */
  verifyServices(): boolean {
    const requiredTokens = [
      DITokens.CONFIG,
      DITokens.API_CLIENT,
      DITokens.AI_MANAGER,
      DITokens.CONTEXT_MANAGER,
      DITokens.COMMAND_MANAGER,
      DITokens.TASK_MANAGER,
      DITokens.HOOK_MANAGER,
    ];

    const missing: string[] = [];
    for (const token of requiredTokens) {
      if (!this.container.isRegistered(token)) {
        missing.push(token);
      }
    }

    if (missing.length > 0) {
      logger.warn(
        `[ServiceRegistry] Missing required services: ${missing.join(', ')}`,
      );
      return false;
    }

    logger.debug('[ServiceRegistry] All required services are registered');
    return true;
  }
}

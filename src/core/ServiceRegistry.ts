// Service Registry - manages service registration to DI container
// Provides a clear, organized way to register services with proper lifecycle management

import type { AIManager } from '@/ai/AIManager';
import type { AIService } from '@/ai/AIService';
import type { APIClient } from '@/api/APIClient';
import type { CommandManager } from '@/command/CommandManager';
import { ConversationConfigService } from '@/config/ConversationConfigService';
import { GlobalConfigManager } from '@/config/GlobalConfigManager';
import type { ContextManager } from '@/context/ContextManager';
import { ProactiveConversationService } from '@/conversation/ProactiveConversationService';
import { ThreadService } from '@/conversation/ThreadService';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { SearchService } from '@/search';
import type { TaskManager } from '@/task/TaskManager';
import { logger } from '@/utils/logger';
import type { Config } from './config';
import { getContainer } from './DIContainer';
import { DITokens } from './DITokens';
import { HealthCheckManager } from './health';

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
   * Register command manager
   */
  registerCommandManager(commandManager: CommandManager): void {
    this.container.registerInstance(DITokens.COMMAND_MANAGER, commandManager);
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
   * Register conversation config services
   */
  registerConversationConfigServices(
    conversationConfigService: ConversationConfigService,
    globalConfigManager: GlobalConfigManager,
  ): void {
    this.container.registerInstance(DITokens.CONVERSATION_CONFIG_SERVICE, conversationConfigService);
    this.container.registerInstance(DITokens.GLOBAL_CONFIG_MANAGER, globalConfigManager);
  }

  /**
   * Register search service
   */
  registerSearchService(searchService: SearchService): void {
    this.container.registerInstance(DITokens.SEARCH_SERVICE, searchService);
  }

  /**
   * Register health check manager
   */
  registerHealthCheckManager(healthCheckManager: HealthCheckManager): void {
    this.container.registerInstance(DITokens.HEALTH_CHECK_MANAGER, healthCheckManager);
  }

  /**
   * Register AIManager with health check manager
   * AIManager will check health of all its managed providers
   */
  registerAIManagerHealthCheck(aiManager: AIManager): void {
    // Get health check manager from container
    if (!this.container.isRegistered(DITokens.HEALTH_CHECK_MANAGER)) {
      logger.warn('[ServiceRegistry] Health check manager not registered, skipping AI manager health check');
      return;
    }

    const healthManager = this.container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);

    // Register AIManager itself (it will check all its providers)
    healthManager.registerService(aiManager, {
      cacheDuration: 120000, // Cache for 2 minutes (AI providers are usually stable)
      timeout: 10000, // 10 second timeout for checking all providers
      retries: 0, // No retries for health checks
    });

    const providerCount = aiManager.getAvailableProviders().length;
    logger.info(`[ServiceRegistry] Registered AIManager health check (managing ${providerCount} providers)`);
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
    conversationConfigService: ConversationConfigService;
    globalConfigManager: GlobalConfigManager;
  }): void {
    // DATABASE_MANAGER and AI_MANAGER may already be registered early for ProactiveConversationService DI
    if (!this.container.isRegistered(DITokens.DATABASE_MANAGER)) {
      this.registerDatabaseService(services.databaseManager);
    }
    if (!this.container.isRegistered(DITokens.AI_MANAGER)) {
      this.registerAIService(services.aiManager);
    }
    this.registerContextService(services.contextManager);
    this.registerCommandService(services.commandManager);
    this.registerTaskService(services.taskManager);
    this.registerHookService(services.hookManager);
    this.registerConversationConfigServices(services.conversationConfigService, services.globalConfigManager);
  }

  /**
   * Register thread service
   * Used to scope proactive participation and to provide thread context for replies.
   */
  registerThreadService(threadService: ThreadService): void {
    this.container.registerInstance(DITokens.THREAD_SERVICE, threadService);
  }

  /**
   * Register proactive conversation service
   * Schedules per-group debounced analysis; when timer fires, runs Ollama and optionally sends a proactive reply.
   */
  registerProactiveConversationService(proactiveConversationService: ProactiveConversationService): void {
    this.container.registerInstance(DITokens.PROACTIVE_CONVERSATION_SERVICE, proactiveConversationService);
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

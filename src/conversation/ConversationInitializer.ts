// Conversation Initializer - initializes all conversation-related components
// Organized into clear phases with distinct responsibilities

import type { APIClient } from '@/api/APIClient';
import { CommandManager } from '@/command';
import { DefaultPermissionChecker } from '@/command/PermissionChecker';
import type { Config } from '@/core/Config';
// Import command handlers to trigger decorator registration
// The decorator will automatically register them when the classes are loaded
import { AIManager, OllamaProvider, OpenAIProvider } from '@/ai';
import '@/command/handlers/BuiltinCommandHandler';
import { ContextManager } from '@/context';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/plugins/HookManager';
import { HookRegistry } from '@/plugins/HookRegistry';
import { ReplyTaskExecutor, TaskAnalyzer, TaskManager } from '@/task';
import { logger } from '@/utils/logger';
import { CommandRouter } from './CommandRouter';
import { ConversationManager } from './ConversationManager';
import { MessagePipeline } from './MessagePipeline';

export interface ConversationComponents {
  conversationManager: ConversationManager;
  hookManager: HookManager;
  hookRegistry: HookRegistry;
  commandManager: CommandManager;
  taskManager: TaskManager;
  aiManager: AIManager;
  contextManager: ContextManager;
  databaseManager?: DatabaseManager;
}

/**
 * Conversation Initializer
 * Initializes all conversation-related components
 * Organized into clear phases:
 * 1. Infrastructure Setup - DI container and service registry
 * 2. Core Services Creation - Create service instances
 * 3. Service Configuration - Configure services (providers, executors, etc.)
 * 4. Service Registration - Register services to DI container
 * 5. Service Wiring - Connect services together (dependencies)
 * 6. Component Assembly - Assemble high-level components (Pipeline, Manager)
 */
export class ConversationInitializer {
  /**
   * Initialize all conversation components
   */
  static async initialize(
    config: Config,
    apiClient: APIClient,
  ): Promise<ConversationComponents> {
    logger.info('[ConversationInitializer] Starting initialization...');

    // Phase 1: Infrastructure Setup
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.registerInfrastructureServices(config, apiClient);
    logger.info(
      '[ConversationInitializer] Phase 1: Infrastructure setup complete',
    );

    // Phase 2: Core Services Creation
    const services = await this.createCoreServices(config);
    logger.info('[ConversationInitializer] Phase 2: Core services created');

    // Phase 3: Service Configuration
    await this.configureServices(services, config);
    logger.info('[ConversationInitializer] Phase 3: Services configured');

    // Phase 4: Service Registration
    serviceRegistry.registerConversationServices(services);
    logger.info(
      '[ConversationInitializer] Phase 4: Services registered to DI container',
    );

    // Phase 5: Service Wiring
    this.wireServices(services);
    logger.info('[ConversationInitializer] Phase 5: Services wired together');

    // Phase 6: Component Assembly
    const components = this.assembleComponents(services, config, apiClient);
    logger.info('[ConversationInitializer] Phase 6: Components assembled');

    // Verify all services are registered
    serviceRegistry.verifyServices();

    logger.info(
      '[ConversationInitializer] All components initialized successfully',
    );

    return components;
  }

  /**
   * Phase 2: Create core service instances
   */
  private static async createCoreServices(config: Config): Promise<{
    databaseManager?: DatabaseManager;
    aiManager: AIManager;
    contextManager: ContextManager;
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }> {
    // Create database manager if configured
    let databaseManager: DatabaseManager | undefined;
    const dbConfig = config.getDatabaseConfig();
    if (dbConfig) {
      databaseManager = new DatabaseManager();
      await databaseManager.initialize(dbConfig);
      logger.debug('[ConversationInitializer] Database manager created');
    }

    // Create AI manager
    const aiManager = new AIManager();
    logger.debug('[ConversationInitializer] AI manager created');

    // Create context manager
    const contextManager = new ContextManager(
      undefined, // Will be set after AI manager is configured
      false, // useSummary
      20, // summaryThreshold
    );
    logger.debug('[ConversationInitializer] Context manager created');

    // Create permission checker
    const botConfig = config.getConfig();
    const permissionChecker = new DefaultPermissionChecker({
      owner: botConfig.bot.owner,
      admins: botConfig.bot.admins,
    });

    // Create command manager (registers itself in DI container during construction)
    const commandManager = new CommandManager(permissionChecker);
    logger.debug('[ConversationInitializer] Command manager created');

    // Create task manager
    const taskManager = new TaskManager();
    logger.debug('[ConversationInitializer] Task manager created');

    // Create hook manager
    const hookManager = new HookManager();
    logger.debug('[ConversationInitializer] Hook manager created');

    return {
      databaseManager,
      aiManager,
      contextManager,
      commandManager,
      taskManager,
      hookManager,
    };
  }

  /**
   * Phase 3: Configure services (providers, executors, etc.)
   */
  private static async configureServices(
    services: {
      aiManager: AIManager;
      contextManager: ContextManager;
      taskManager: TaskManager;
    },
    config: Config,
  ): Promise<void> {
    // Configure AI Manager
    const aiConfig = config.getAIConfig();
    if (aiConfig) {
      // Register AI providers
      for (const [name, providerConfig] of Object.entries(aiConfig.providers)) {
        if (providerConfig.type === 'openai') {
          const provider = new OpenAIProvider({
            apiKey: providerConfig.apiKey,
            model: providerConfig.model,
            baseURL: providerConfig.baseURL,
            defaultTemperature: providerConfig.temperature,
            defaultMaxTokens: providerConfig.maxTokens,
          });
          services.aiManager.registerProvider(provider);
        } else if (providerConfig.type === 'ollama') {
          const provider = new OllamaProvider({
            baseUrl: providerConfig.baseUrl,
            model: providerConfig.model,
            defaultTemperature: providerConfig.temperature,
            defaultMaxTokens: 2000, // Ollama doesn't have maxTokens in config
          });
          services.aiManager.registerProvider(provider);
        }
        // Add other providers here (Anthropic, etc.)
      }

      // Set current provider
      if (aiConfig.provider) {
        services.aiManager.setCurrentProvider(aiConfig.provider);
      }

      // Update context manager with AI manager
      services.contextManager = new ContextManager(
        services.aiManager.getCurrentProvider()
          ? services.aiManager
          : undefined,
        false, // useSummary
        20, // summaryThreshold
      );
      logger.debug('[ConversationInitializer] AI manager configured');
    }

    // Configure Task Manager
    const taskConfig = (config.getConfig() as any).task;
    services.taskManager.registerExecutor(new ReplyTaskExecutor());

    if (taskConfig?.types) {
      for (const taskType of taskConfig.types) {
        services.taskManager.registerTaskType({
          name: taskType.name,
          description: taskType.description,
          executor: taskType.executor,
        });
      }
    }
    logger.debug('[ConversationInitializer] Task manager configured');
  }

  /**
   * Phase 4: Service Registration is handled by ServiceRegistry.registerConversationServices
   * (called in main initialize method)
   */

  /**
   * Phase 5: Wire services together (set dependencies)
   */
  private static wireServices(services: {
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }): void {
    // Connect hook manager to command and task systems
    services.commandManager.setHookManager(services.hookManager);
    services.taskManager.setHookManager(services.hookManager);
    logger.debug('[ConversationInitializer] Services wired together');
  }

  /**
   * Phase 6: Assemble high-level components
   */
  private static assembleComponents(
    services: {
      aiManager: AIManager;
      contextManager: ContextManager;
      commandManager: CommandManager;
      taskManager: TaskManager;
      hookManager: HookManager;
      databaseManager?: DatabaseManager;
    },
    config: Config,
    apiClient: APIClient,
  ): ConversationComponents {
    // Create hook registry
    const hookRegistry = new HookRegistry(services.hookManager);

    // Create task analyzer
    const taskAnalyzer = new TaskAnalyzer(
      services.aiManager,
      services.taskManager,
    );

    // Create command router
    const commandConfig = (config.getConfig() as any).command;
    const prefixes = commandConfig?.prefixes || ['/', '!'];
    const commandRouter = new CommandRouter(prefixes);

    // Create message pipeline
    const pipeline = new MessagePipeline(
      commandRouter,
      services.commandManager,
      services.taskManager,
      taskAnalyzer,
      services.contextManager,
      services.aiManager,
      services.hookManager,
      apiClient,
    );

    // Create conversation manager
    const conversationManager = new ConversationManager(pipeline);

    return {
      conversationManager,
      hookManager: services.hookManager,
      hookRegistry,
      commandManager: services.commandManager,
      taskManager: services.taskManager,
      aiManager: services.aiManager,
      contextManager: services.contextManager,
      databaseManager: services.databaseManager,
    };
  }
}

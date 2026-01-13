// Conversation Initializer - initializes all conversation-related components

import '@/command/handlers/BuiltinCommandHandler';

import {
  AIManager,
  AIService,
  CapabilityType,
  LLMService,
  PromptManager,
  ProviderFactory,
  ProviderSelector,
} from '@/ai';
import type { APIClient } from '@/api/APIClient';
import { CommandManager } from '@/command';
import { DefaultPermissionChecker } from '@/command/PermissionChecker';
import { ContextManager } from '@/context';
import type { AIConfig, BotConfig, Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { SystemRegistry, type SystemContext } from '@/core/system';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/hooks/HookManager';
import { ReplyTaskExecutor, TaskAnalyzer, TaskManager } from '@/task';
import type { TaskType } from '@/task/types';
import { logger } from '@/utils/logger';
import { CommandRouter } from './CommandRouter';
import { ConversationManager } from './ConversationManager';
import { Lifecycle } from './Lifecycle';
import { MessagePipeline } from './MessagePipeline';
import { CommandSystem } from './systems/CommandSystem';
import { DatabasePersistenceSystem } from './systems/DatabasePersistenceSystem';
import { TaskSystem } from './systems/TaskSystem';

/**
 * Extended BotConfig with optional task configuration
 */
interface BotConfigWithTask extends BotConfig {
  task?: {
    types?: TaskType[];
  };
}

export interface ConversationComponents {
  conversationManager: ConversationManager;
  hookManager: HookManager;
  commandManager: CommandManager;
  taskManager: TaskManager;
  aiManager: AIManager;
  contextManager: ContextManager;
  databaseManager: DatabaseManager;
  systemRegistry: SystemRegistry;
  lifecycle: Lifecycle;
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
 * 7. System Registration - Register and initialize business systems
 */
export class ConversationInitializer {
  /**
   * Initialize all conversation components
   */
  static async initialize(config: Config, apiClient: APIClient): Promise<ConversationComponents> {
    // Phase 1: Infrastructure Setup
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.registerInfrastructureServices(config, apiClient);

    // Phase 2: Core Services Creation
    const services = await this.createCoreServices(config);

    // Phase 3: Service Configuration
    await this.configureServices(services, config);

    // Phase 4: Service Registration
    serviceRegistry.registerConversationServices(services);

    // Create ProviderSelector and LLMService for AI capabilities
    const providerSelector = new ProviderSelector(services.aiManager, services.databaseManager);
    const llmService = new LLMService(services.aiManager, providerSelector);

    // Update ContextManager with LLMService if summary is enabled
    const memoryConfig = config.getContextMemoryConfig();
    const useSummary = memoryConfig?.useSummary ?? false;
    if (useSummary) {
      const summaryThreshold = memoryConfig?.summaryThreshold ?? 20;
      const maxBufferSize = memoryConfig?.maxBufferSize ?? 30;
      const currentProvider = services.aiManager.getCurrentProvider();
      if (currentProvider) {
        services.contextManager = new ContextManager(llmService, useSummary, summaryThreshold, maxBufferSize);
      }
    }

    // Create and register AIService if AI provider is available
    const currentProvider = services.aiManager.getCurrentProvider();
    if (currentProvider) {
      const taskAnalyzer = new TaskAnalyzer(llmService, services.taskManager);
      const maxHistoryMessages = memoryConfig?.maxHistoryMessages ?? 10;
      const container = getContainer();
      const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);

      const aiService = new AIService(
        services.aiManager,
        services.contextManager,
        services.hookManager,
        promptManager,
        taskAnalyzer,
        maxHistoryMessages,
        providerSelector,
      );
      serviceRegistry.registerAIServiceCapabilities(aiService);
    } else {
      logger.warn('[ConversationInitializer] No AI provider available. AIService will not be registered.');
    }

    // Phase 5: Service Wiring
    this.wireServices(services);

    // Phase 6: Component Assembly
    const components = this.assembleComponents(services, apiClient);

    // Phase 7: Register and initialize systems
    await this.registerAndInitializeSystems(components, services, config);

    serviceRegistry.verifyServices();

    return components;
  }

  /**
   * Phase 2: Create core service instances
   */
  private static async createCoreServices(config: Config): Promise<{
    databaseManager: DatabaseManager;
    aiManager: AIManager;
    contextManager: ContextManager;
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }> {
    const dbConfig = config.getDatabaseConfig();
    const databaseManager = new DatabaseManager();
    await databaseManager.initialize(dbConfig);

    const aiManager = new AIManager();

    const memoryConfig = config.getContextMemoryConfig();
    const useSummary = memoryConfig?.useSummary ?? false;
    const summaryThreshold = memoryConfig?.summaryThreshold ?? 20;
    const maxBufferSize = memoryConfig?.maxBufferSize ?? 30;

    // ContextManager will be updated with LLMService later if summary is enabled
    const contextManager = new ContextManager(undefined, useSummary, summaryThreshold, maxBufferSize);

    const botConfig = config.getConfig();
    const permissionChecker = new DefaultPermissionChecker({
      owner: botConfig.bot.owner,
      admins: botConfig.bot.admins,
    });

    // CommandManager registers itself in DI container during construction
    const commandManager = new CommandManager(permissionChecker);

    const taskManager = new TaskManager();
    const hookManager = new HookManager();

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
    this.configureAIManager(services.aiManager, services.contextManager, config);
    this.configureTaskManager(services.taskManager, config);
  }

  /**
   * Configure AI Manager with providers from config
   */
  private static configureAIManager(aiManager: AIManager, contextManager: ContextManager, config: Config): void {
    const aiConfig = config.getAIConfig();
    if (!aiConfig) {
      logger.warn('[ConversationInitializer] No AI configuration found. AI capabilities will not be available.');
      return;
    }

    const providers = ProviderFactory.createProviders(aiConfig.providers);
    const registeredProviders: string[] = [];

    for (const { name, provider } of providers) {
      try {
        aiManager.registerProvider(provider);
        registeredProviders.push(name);
      } catch (error) {
        logger.warn(`[ConversationInitializer] Failed to register provider ${name}:`, error);
      }
    }

    if (registeredProviders.length === 0) {
      logger.warn('[ConversationInitializer] No providers were successfully registered');
      return;
    }

    this.configureDefaultProviders(aiManager, aiConfig);
  }

  /**
   * Configure default providers by capability
   */
  private static configureDefaultProviders(aiManager: AIManager, aiConfig: AIConfig): void {
    if (!aiConfig.defaultProviders) {
      return;
    }

    const validCapabilities: CapabilityType[] = ['llm', 'vision', 'text2img', 'img2img'];

    for (const capability of validCapabilities) {
      const providerName = aiConfig.defaultProviders[capability];
      if (!providerName) {
        continue;
      }

      try {
        aiManager.setDefaultProvider(capability, providerName);
      } catch (error) {
        logger.warn(
          `[ConversationInitializer] Failed to set default provider ${providerName} for ${capability}:`,
          error,
        );
      }
    }
  }

  /**
   * Configure Task Manager
   */
  private static configureTaskManager(taskManager: TaskManager, config: Config): void {
    // Register default reply executor
    taskManager.registerExecutor(new ReplyTaskExecutor());

    // Register default "reply" task type
    taskManager.registerTaskType({
      name: 'reply',
      description: 'AI reply task - generates AI response for user input',
      executor: 'reply',
    });

    // Register additional task types from config
    const botConfig = config.getConfig() as BotConfigWithTask;
    const taskConfig = botConfig.task;
    if (taskConfig?.types) {
      for (const taskType of taskConfig.types) {
        // Skip "reply" if already registered
        if (taskType.name.toLowerCase() !== 'reply') {
          taskManager.registerTaskType({
            name: taskType.name,
            description: taskType.description,
            executor: taskType.executor,
            parameters: taskType.parameters,
          });
        }
      }
    }
  }

  /**
   * Phase 5: Wire services together (set dependencies)
   */
  private static wireServices(services: {
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }): void {
    services.commandManager.setHookManager(services.hookManager);
    services.taskManager.setHookManager(services.hookManager);
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
      databaseManager: DatabaseManager;
    },
    apiClient: APIClient,
  ): ConversationComponents {
    const systemRegistry = new SystemRegistry();
    const commandRouter = new CommandRouter(['/', '!']);
    const lifecycle = new Lifecycle(services.hookManager);
    lifecycle.setCommandRouter(commandRouter);
    const pipeline = new MessagePipeline(lifecycle, services.hookManager, apiClient);
    // ConversationManager gets botSelfId from config via DI container
    const conversationManager = new ConversationManager(pipeline);

    return {
      conversationManager,
      hookManager: services.hookManager,
      commandManager: services.commandManager,
      taskManager: services.taskManager,
      aiManager: services.aiManager,
      contextManager: services.contextManager,
      databaseManager: services.databaseManager,
      systemRegistry,
      lifecycle,
    };
  }

  /**
   * Phase 7: Register and initialize systems
   */
  private static async registerAndInitializeSystems(
    components: ConversationComponents,
    services: {
      aiManager: AIManager;
      contextManager: ContextManager;
      commandManager: CommandManager;
      taskManager: TaskManager;
      hookManager: HookManager;
      databaseManager: DatabaseManager;
    },
    config: Config,
  ): Promise<void> {
    const { systemRegistry } = components;

    const systemContext: SystemContext = {
      hookManager: services.hookManager,
      getSystem: (name) => systemRegistry.getSystem(name),
      config: config.getConfig(),
    };

    systemRegistry.registerSystemFactory('command', () => {
      return new CommandSystem(services.commandManager, services.hookManager);
    });

    systemRegistry.registerSystemFactory('task', () => {
      return new TaskSystem(services.taskManager, services.hookManager);
    });

    systemRegistry.registerSystemFactory('database-persistence', () => {
      return new DatabasePersistenceSystem(services.databaseManager);
    });

    await systemRegistry.createSystems(systemContext);
    await systemRegistry.initializeSystems(systemContext);

    // Register all systems to lifecycle for execution at different stages
    const { lifecycle } = components;
    const businessSystems = systemRegistry.getAllSystems();
    for (const system of businessSystems) {
      lifecycle.registerSystem(system);
    }
  }
}

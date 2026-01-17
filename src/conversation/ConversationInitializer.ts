// Conversation Initializer - initializes all conversation-related components

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
import { MessageUtils } from '@/message/MessageUtils';
import type { SearchService } from '@/search';
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
 * Complete services type (includes ContextManager created in Phase 4)
 */
type CompleteServices = {
  databaseManager: DatabaseManager;
  aiManager: AIManager;
  contextManager: ContextManager;
  commandManager: CommandManager;
  taskManager: TaskManager;
  hookManager: HookManager;
};

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
  static async initialize(
    config: Config,
    apiClient: APIClient,
    searchService?: SearchService,
  ): Promise<ConversationComponents> {
    // Phase 1: Infrastructure Setup
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.registerInfrastructureServices(config, apiClient);

    // Phase 2: Core Services Creation
    const services = await this.createCoreServices(config);

    // Phase 3: Service Configuration
    await this.configureServices(services, config);

    // Phase 4: Create LLMService and ContextManager
    const providerSelector = new ProviderSelector(services.aiManager, services.databaseManager);
    const llmService = new LLMService(services.aiManager, providerSelector);

    const memoryConfig = config.getContextMemoryConfig();
    const useSummary = memoryConfig?.useSummary ?? false;
    const summaryThreshold = memoryConfig?.summaryThreshold ?? 20;
    const maxBufferSize = memoryConfig?.maxBufferSize ?? 30;
    const maxHistoryMessages = memoryConfig?.maxHistoryMessages ?? 10;

    const promptManager = getContainer().resolve<PromptManager>(DITokens.PROMPT_MANAGER);

    const contextManager = new ContextManager(llmService, promptManager, useSummary, summaryThreshold, maxBufferSize);

    const completeServices: CompleteServices = {
      ...services,
      contextManager,
    };
    serviceRegistry.registerConversationServices(completeServices);
    // commandManager will be auto registered by injector.
    // serviceRegistry.registerCommandManager(completeServices.commandManager);

    const taskAnalyzer = new TaskAnalyzer(llmService, completeServices.taskManager, promptManager);
    const aiService = new AIService(
      completeServices.aiManager,
      completeServices.contextManager,
      completeServices.hookManager,
      promptManager,
      taskAnalyzer,
      maxHistoryMessages,
      providerSelector,
      searchService,
    );
    serviceRegistry.registerAIServiceCapabilities(aiService);

    // Phase 5: Service Wiring
    this.wireServices(completeServices);

    // Phase 6: Component Assembly
    const components = this.assembleComponents(completeServices, apiClient);

    // Phase 7: Register and initialize systems
    await this.registerAndInitializeSystems(components, completeServices, config);

    serviceRegistry.verifyServices();

    return components;
  }

  /**
   * Phase 2: Create core service instances (without ContextManager)
   * ContextManager requires LLMService, which is created in Phase 4
   */
  private static async createCoreServices(config: Config): Promise<{
    databaseManager: DatabaseManager;
    aiManager: AIManager;
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }> {
    const dbConfig = config.getDatabaseConfig();
    const databaseManager = new DatabaseManager();
    await databaseManager.initialize(dbConfig);

    const aiManager = new AIManager();

    const botConfig = config.getConfig();
    const permissionChecker = new DefaultPermissionChecker({
      owner: botConfig.bot.owner,
      admins: botConfig.bot.admins,
    });

    const commandManager = new CommandManager(permissionChecker);

    const taskManager = new TaskManager();
    const hookManager = new HookManager();

    return {
      databaseManager,
      aiManager,
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
      taskManager: TaskManager;
    },
    config: Config,
  ): Promise<void> {
    this.configureAIManager(services.aiManager, config);
    this.configureTaskManager(services.taskManager, config);
  }

  /**
   * Configure AI Manager with providers from config
   */
  private static configureAIManager(aiManager: AIManager, config: Config): void {
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
   * Priority: 1. Config specified providers, 2. First available provider
   */
  private static configureDefaultProviders(aiManager: AIManager, aiConfig: AIConfig): void {
    const validCapabilities: CapabilityType[] = ['llm', 'vision', 'text2img', 'img2img'];

    // First, set default providers from config if specified
    if (aiConfig.defaultProviders) {
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

    // Then, for capabilities without default provider, use the first available provider
    for (const capability of validCapabilities) {
      // Skip if default is already set (from config)
      if (aiManager.getDefaultProvider(capability)) {
        continue;
      }

      // Find first available provider for this capability
      // Try to get provider by trying each registered provider
      const allProviders = aiManager.getAllProviders();
      const firstAvailableProvider = allProviders.find(
        (p) => p.getCapabilities().includes(capability) && p.isAvailable(),
      );

      if (firstAvailableProvider) {
        try {
          aiManager.setDefaultProvider(capability, firstAvailableProvider.name);
          logger.info(
            `[ConversationInitializer] Set ${firstAvailableProvider.name} as default provider for ${capability} (first available)`,
          );
        } catch (error) {
          logger.warn(
            `[ConversationInitializer] Failed to set default provider ${firstAvailableProvider.name} for ${capability}:`,
            error,
          );
        }
      } else {
        logger.warn(`[ConversationInitializer] No available providers for capability ${capability}`);
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
      description: 'AI 回复任务 - 生成 AI 响应回复用户输入',
      executor: 'reply',
      whenToUse:
        '当用户发送一般性对话、询问、聊天消息时使用此任务类型。这是默认任务类型，适用于所有不匹配其他特定任务类型的消息。',
      examples: ['你好', '今天天气怎么样？', '帮我解释一下什么是人工智能', '给我讲个笑话'],
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
            examples: taskType.examples,
            triggerKeywords: taskType.triggerKeywords,
            whenToUse: taskType.whenToUse,
          });
        }
      }
    }
  }

  /**
   * Phase 5: Wire services together (set dependencies)
   */
  private static wireServices(services: CompleteServices): void {
    services.commandManager.setHookManager(services.hookManager);
    services.taskManager.setHookManager(services.hookManager);
  }

  /**
   * Phase 6: Assemble high-level components
   */
  private static assembleComponents(services: CompleteServices, apiClient: APIClient): ConversationComponents {
    const systemRegistry = new SystemRegistry();
    const commandRouter = new CommandRouter(['/', '!']);

    // Initialize MessageUtils with command prefixes
    MessageUtils.initialize(['/', '!']);

    const lifecycle = new Lifecycle(services.hookManager, commandRouter);

    const pipeline = new MessagePipeline(lifecycle, services.hookManager, apiClient, services.contextManager);
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
    services: CompleteServices,
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

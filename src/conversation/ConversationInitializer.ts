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
import { OllamaPreliminaryAnalysisService } from '@/ai/services/OllamaPreliminaryAnalysisService';
import type { APIClient } from '@/api/APIClient';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { CommandManager } from '@/command';
import { DefaultPermissionChecker } from '@/command/PermissionChecker';
import { ConversationConfigService } from '@/config/ConversationConfigService';
import { GlobalConfigManager } from '@/config/GlobalConfigManager';
import { ContextManager } from '@/context';
import type { AIConfig, Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HealthCheckManager } from '@/core/health';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { type SystemContext, SystemRegistry } from '@/core/system';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/hooks/HookManager';
import { MessageUtils } from '@/message/MessageUtils';
import type { SearchService } from '@/search';
import { TaskInitializer, TaskManager } from '@/task';
import { logger } from '@/utils/logger';
import { CommandRouter } from './CommandRouter';
import { ConversationManager } from './ConversationManager';
import { GroupHistoryService } from './GroupHistoryService';
import { Lifecycle } from './Lifecycle';
import { MessagePipeline } from './MessagePipeline';
import {
  SearXNGPreferenceKnowledgeService
} from './PreferenceKnowledgeService';
import { ProactiveConversationService } from './ProactiveConversationService';
import { DefaultProactiveThreadPersistenceService } from './ProactiveThreadPersistenceService';
import { SummarizeService } from './SummarizeService';
import { CommandSystem } from './systems/CommandSystem';
import { DatabasePersistenceSystem } from './systems/DatabasePersistenceSystem';
import { TaskSystem } from './systems/TaskSystem';
import { ThreadContextCompressionService } from './ThreadContextCompressionService';
import { ThreadService } from './ThreadService';

export interface ConversationComponents {
  conversationManager: ConversationManager;
  hookManager: HookManager;
  commandManager: CommandManager;
  taskManager: TaskManager;
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
  aiManager: AIManager; // Required for DI registration and service creation
  aiService: AIService; // Business logic layer
  contextManager: ContextManager;
  commandManager: CommandManager;
  taskManager: TaskManager;
  hookManager: HookManager;
  conversationConfigService: ConversationConfigService;
  globalConfigManager: GlobalConfigManager;
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
    const container = getContainer();
    // Phase 1: Infrastructure Setup
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.registerInfrastructureServices(config, apiClient);

    // Phase 2: Create core service instances (CommandManager requires ConversationConfigService)
    // DatabaseManager must be created first for ConversationConfigService
    const dbConfig = config.getDatabaseConfig();
    const databaseManager = new DatabaseManager();
    await databaseManager.initialize(dbConfig);
    container.registerInstance(DITokens.DATABASE_MANAGER, databaseManager, { logRegistration: false });

    // Phase 2.1: Create HealthCheckManager early for service health monitoring
    const healthCheckManager = new HealthCheckManager();
    serviceRegistry.registerHealthCheckManager(healthCheckManager);

    // Phase 2.5: Initialize Conversation Config Services (required before CommandManager)
    const globalConfigManager = new GlobalConfigManager();
    const conversationConfigService = new ConversationConfigService(databaseManager.getAdapter(), globalConfigManager);

    // Phase 2.6: Create remaining core services (CommandManager requires ConversationConfigService)
    const services = await this.createCoreServices(config, conversationConfigService, databaseManager);

    // Phase 3: Service Configuration
    await this.configureServices(services, config);

    // Phase 3.5: Register AIManager with health check manager
    serviceRegistry.registerAIManagerHealthCheck(services.aiManager);

    // Phase 4: Create LLMService and ContextManager
    const providerSelector = new ProviderSelector(services.aiManager, conversationConfigService);
    const llmService = new LLMService(services.aiManager, providerSelector);
    container.registerInstance(DITokens.LLM_SERVICE, llmService, { logRegistration: false });

    const memoryConfig = config.getContextMemoryConfig();
    const useSummary = memoryConfig?.useSummary ?? false;
    const summaryThreshold = memoryConfig?.summaryThreshold ?? 20;
    const maxBufferSize = memoryConfig?.maxBufferSize ?? 30;
    const maxHistoryMessages = memoryConfig?.maxHistoryMessages ?? 10;

    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);

    // Single SummarizeService for both context memory and thread compression (provider passed at call time).
    const summarizeService = new SummarizeService(llmService, promptManager);
    container.registerInstance(DITokens.SUMMARIZE_SERVICE, summarizeService, { logRegistration: false });
    const contextManager = new ContextManager(
      summaryThreshold,
      maxBufferSize,
      useSummary,
      summarizeService,
    );

    // Register conversation config services to DI container early so PluginManager can inject them
    // This must be done before PluginManager is created
    serviceRegistry.registerConversationConfigServices(conversationConfigService, globalConfigManager);

    // Register SearchService to DI container if available (for SearchTaskExecutor)
    if (searchService) {
      serviceRegistry.registerSearchService(searchService);
    }

    // Create AIService (MessageAPI from apiClient for vision reply: extract images from current + referenced messages)
    const messageAPI = new MessageAPI(apiClient);
    container.registerInstance(DITokens.MESSAGE_API, messageAPI, { logRegistration: false });
    const aiService = new AIService(
      services.aiManager,
      services.hookManager,
      promptManager,
      services.taskManager,
      maxHistoryMessages,
      providerSelector,
      searchService,
      messageAPI,
      databaseManager,
    );
    serviceRegistry.registerAIServiceCapabilities(aiService);

    // Proactive conversation (Phase 1): group history, thread, Ollama analysis, orchestrator (Phase 4: thread compression)
    // Dependencies resolved from DI container; see createProactiveConversationFromContainer
    this.configureProactiveConversationService(serviceRegistry);

    const completeServices: CompleteServices = {
      ...services,
      aiService,
      contextManager,
      conversationConfigService,
      globalConfigManager,
    };
    serviceRegistry.registerConversationServices(completeServices);
    // commandManager will be auto registered by injector.
    // serviceRegistry.registerCommandManager(completeServices.commandManager);

    // Phase 5: Component Assembly
    const components = this.assembleComponents(completeServices, apiClient);

    // Phase 6: Register and initialize systems (includes service wiring and config loading)
    await this.registerAndInitializeSystems(components, completeServices, config);

    serviceRegistry.verifyServices();

    return components;
  }

  /**
   * Phase 2: Create core service instances (without ContextManager)
   * ContextManager requires LLMService, which is created in Phase 4
   * Note: ConversationConfigService is created before CommandManager because CommandManager requires it
   * Note: DatabaseManager is passed in because it's already initialized
   */
  private static async createCoreServices(
    config: Config,
    conversationConfigService: ConversationConfigService,
    databaseManager: DatabaseManager,
  ): Promise<{
    databaseManager: DatabaseManager;
    aiManager: AIManager;
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }> {
    const container = getContainer();
    const aiManager = new AIManager();
    container.registerInstance(DITokens.AI_MANAGER, aiManager, { logRegistration: false });

    const botConfig = config.getConfig();
    const permissionChecker = new DefaultPermissionChecker({
      owner: botConfig.bot.owner,
      admins: botConfig.bot.admins,
    });

    const commandManager = new CommandManager(permissionChecker, conversationConfigService);

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
      return;
    }

    this.configureDefaultProviders(aiManager, aiConfig);
  }

  /**
   * Configure proactive conversation service by resolving dependencies from DI container.
   * Creates GroupHistoryService, ThreadService, OllamaAnalysis, etc. from registered tokens
   * and registers ThreadService + ProactiveConversationService.
   */
  private static configureProactiveConversationService(serviceRegistry: ServiceRegistry): void {
    const { threadService, proactiveConversationService } =
      this.createProactiveConversationFromContainer();
    serviceRegistry.registerThreadService(threadService);
    serviceRegistry.registerProactiveConversationService(proactiveConversationService);
  }

  /**
   * Register proactive-related dependencies into the container, then resolve ProactiveConversationService.
   * ProactiveConversationService is @injectable(); the container injects all 9 deps into its constructor.
   * Returns threadService and proactiveConversationService for ServiceRegistry registration.
   */
  private static createProactiveConversationFromContainer(
  ): { threadService: ThreadService; proactiveConversationService: ProactiveConversationService } {
    const container = getContainer();
    const databaseManager = container.resolve<DatabaseManager>(DITokens.DATABASE_MANAGER);
    const aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER);
    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const summarizeService = container.resolve<SummarizeService>(DITokens.SUMMARIZE_SERVICE);

    const groupHistoryService = new GroupHistoryService(databaseManager, 30);
    const threadService = new ThreadService();
    container.registerInstance(DITokens.GROUP_HISTORY_SERVICE, groupHistoryService, { logRegistration: false });
    container.registerInstance(DITokens.THREAD_SERVICE, threadService, { logRegistration: false });
    container.registerInstance(
      DITokens.OLLAMA_PRELIMINARY_ANALYSIS_SERVICE,
      new OllamaPreliminaryAnalysisService(aiManager, promptManager),
      { logRegistration: false },
    );
    // Use SearXNG-based preference knowledge when SearchService is available and enabled.
    // Search decision (whether/what to search) is done at analysis stage; retrieve() only executes queries.
    const searchService = container.resolve<SearchService>(DITokens.SEARCH_SERVICE);
    const preferenceKnowledge = new SearXNGPreferenceKnowledgeService(searchService)
    container.registerInstance(DITokens.PREFERENCE_KNOWLEDGE_SERVICE, preferenceKnowledge, {
      logRegistration: false,
    });
    container.registerInstance(
      DITokens.PROACTIVE_THREAD_PERSISTENCE_SERVICE,
      new DefaultProactiveThreadPersistenceService(databaseManager),
      { logRegistration: false },
    );
    container.registerInstance(
      DITokens.THREAD_CONTEXT_COMPRESSION_SERVICE,
      new ThreadContextCompressionService(threadService, summarizeService, promptManager),
      { logRegistration: false },
    );

    container.registerSingleton(DITokens.PROACTIVE_CONVERSATION_SERVICE, ProactiveConversationService);
    const proactiveConversationService = container.resolve<ProactiveConversationService>(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
    );
    const threadServiceResolved = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
    return { threadService: threadServiceResolved, proactiveConversationService };
  }

  /**
   * Configure default providers by capability
   * Priority: 1. Config specified providers, 2. First available provider
   */
  private static configureDefaultProviders(aiManager: AIManager, aiConfig: AIConfig): void {
    const validCapabilities: CapabilityType[] = ['llm', 'vision', 'text2img', 'img2img', 'i2v'];

    // Log loaded defaultProviders so we can verify config is applied (e.g. text2img = google-cloud-run)
    if (aiConfig.defaultProviders) {
      logger.debug(
        `[ConversationInitializer] defaultProviders from config: ${JSON.stringify(aiConfig.defaultProviders)}`,
      );
    }

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
   * Task registration is handled by TaskInitializer using decorators
   */
  private static configureTaskManager(taskManager: TaskManager, config: Config): void {
    // Initialize task system - this will auto-register all decorated task executors
    TaskInitializer.initialize(taskManager);
  }

  /**
   * Phase 5: Assemble high-level components
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
      contextManager: services.contextManager,
      databaseManager: services.databaseManager,
      systemRegistry,
      lifecycle,
    };
  }

  /**
   * Phase 6: Register and initialize systems (includes service wiring and config loading)
   */
  private static async registerAndInitializeSystems(
    components: ConversationComponents,
    services: CompleteServices,
    config: Config,
  ): Promise<void> {
    const { systemRegistry } = components;

    // Wire services together (set dependencies)
    services.commandManager.setHookManager(services.hookManager);

    // Load all conversation configs from database
    await services.conversationConfigService.loadAllConfigs();

    const systemContext: SystemContext = {
      hookManager: services.hookManager,
      getSystem: (name) => systemRegistry.getSystem(name),
      config: config.getConfig(),
    };

    systemRegistry.registerSystemFactory('command', () => {
      return new CommandSystem(services.commandManager, services.hookManager);
    });

    systemRegistry.registerSystemFactory('task', () => {
      return new TaskSystem(services.taskManager, services.hookManager, services.aiService);
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

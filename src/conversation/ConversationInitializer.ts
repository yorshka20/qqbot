// Conversation Initializer - initializes all conversation-related components
/** biome-ignore-all lint/complexity/noThisInStatic: <explanation> */

import {
  AIManager,
  AIService,
  type CapabilityType,
  LLMService,
  type PromptManager,
  ProviderFactory,
  ProviderSelector,
} from '@/ai';
import { PreliminaryAnalysisService } from '@/ai/services/PreliminaryAnalysisService';
import type { APIClient } from '@/api/APIClient';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { CommandManager } from '@/command';
import { DefaultPermissionChecker } from '@/command/PermissionChecker';
import { ConversationConfigService } from '@/config/ConversationConfigService';
import { GlobalConfigManager } from '@/config/GlobalConfigManager';
import { ContextManager } from '@/context';
import { ConversationHistoryService, SessionHistoryStore } from '@/conversation/history';
import type { AIConfig, Config } from '@/core/config';
import { type DIContainer, getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HealthCheckManager } from '@/core/health';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { type SystemContext, SystemRegistry } from '@/core/system';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/hooks/HookManager';
import { MemoryExtractService, MemoryService } from '@/memory';
import { MessageUtils } from '@/message/MessageUtils';
import type { RetrievalService } from '@/retrieval';
import { FileReadService } from '@/services/FileReadService';
import { TaskInitializer, TaskManager } from '@/task';
import { logger } from '@/utils/logger';
import { SummarizeService } from '../ai/services/SummarizeService';
import { CommandRouter } from './CommandRouter';
import { ConversationManager } from './ConversationManager';
import { Lifecycle } from './Lifecycle';
import { MessagePipeline } from './MessagePipeline';
import { ProcessStageInterceptorRegistry } from './ProcessStageInterceptor';
import {
  DefaultPreferenceKnowledgeService,
  DefaultProactiveThreadPersistenceService,
  ProactiveConversationService,
  SearXNGPreferenceKnowledgeService,
} from './proactive';
import { CommandSystem } from './systems/CommandSystem';
import { DatabasePersistenceSystem } from './systems/DatabasePersistenceSystem';
import { RAGPersistenceSystem } from './systems/RAGPersistenceSystem';
import { TaskSystem } from './systems/TaskSystem';
import { ThreadContextCompressionService, ThreadService } from './thread';

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
  private static container: DIContainer;
  /**
   * Initialize all conversation components
   */
  static async initialize(
    config: Config,
    apiClient: APIClient,
    retrievalService: RetrievalService,
  ): Promise<ConversationComponents> {
    this.container = getContainer();
    // Phase 1: Infrastructure Setup
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.registerInfrastructureServices(config, apiClient);

    // Phase 2: Create core service instances (CommandManager requires ConversationConfigService)
    // DatabaseManager must be created first for ConversationConfigService
    const dbConfig = config.getDatabaseConfig();
    const databaseManager = new DatabaseManager();
    await databaseManager.initialize(dbConfig);
    this.container.registerInstance(DITokens.DATABASE_MANAGER, databaseManager, { logRegistration: false });

    // Memory service: file-based persistence (config.memory.dir, default data/memory)
    const memoryDir = config.getMemoryConfig().dir;
    const memoryService = new MemoryService({ memoryDir });
    this.container.registerInstance(DITokens.MEMORY_SERVICE, memoryService, { logRegistration: false });

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
    this.container.registerInstance(DITokens.LLM_SERVICE, llmService, { logRegistration: false });

    const memoryConfig = config.getContextMemoryConfig();
    const useSummary = memoryConfig?.useSummary ?? false;
    const summaryThreshold = memoryConfig?.summaryThreshold ?? 20;
    const maxBufferSize = memoryConfig?.maxBufferSize ?? 30;
    const maxHistoryMessages = memoryConfig?.maxHistoryMessages ?? 10;

    // Single conversation history service: DB load + format (User<userId:nickname> / Assistant) + buildConversationHistory for prompt
    const conversationHistoryService = new ConversationHistoryService(databaseManager, 30, maxHistoryMessages);
    this.container.registerInstance(DITokens.CONVERSATION_HISTORY_SERVICE, conversationHistoryService, {
      logRegistration: false,
    });

    const promptManager = this.container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    // Single SummarizeService for both context memory and thread compression (provider passed at call time).
    const summarizeService = new SummarizeService(llmService, promptManager);

    // Memory extract service (used by Memory plugin for debounced extract from recent messages)
    const memoryExtractService = new MemoryExtractService(promptManager, llmService, memoryService);
    this.container.registerInstance(DITokens.MEMORY_EXTRACT_SERVICE, memoryExtractService, { logRegistration: false });

    this.container.registerInstance(DITokens.SUMMARIZE_SERVICE, summarizeService, { logRegistration: false });
    const sessionHistoryStore = new SessionHistoryStore(maxBufferSize, summaryThreshold, useSummary);
    const contextManager = new ContextManager(sessionHistoryStore);

    // Register conversation config services to DI container early so PluginManager can inject them
    // This must be done before PluginManager is created
    serviceRegistry.registerConversationConfigServices(conversationConfigService, globalConfigManager);

    // Register RetrievalService to DI container (for SearchTaskExecutor, etc.)
    serviceRegistry.registerRetrievalService(retrievalService);

    // Register FileReadService (for ReadFileTaskExecutor and ls/cat commands)
    const fileReadService = new FileReadService(config.getFileReadServiceConfig());
    serviceRegistry.registerFileReadService(fileReadService);

    // Create AIService (MessageAPI from apiClient for vision reply: extract images from current + referenced messages)
    const messageAPI = new MessageAPI(apiClient);
    this.container.registerInstance(DITokens.MESSAGE_API, messageAPI, { logRegistration: false });
    const aiService = new AIService(
      services.aiManager,
      services.hookManager,
      promptManager,
      services.taskManager,
      conversationHistoryService,
      providerSelector,
      retrievalService,
      memoryService,
    );
    serviceRegistry.registerAIServiceCapabilities(aiService);

    // Create and register TaskSystem before ProactiveConversationService so DI can inject it.
    // ProactiveConversationService constructor requires TaskSystem at position #9.
    // MessageAPI and DatabaseManager are optional; when present, explainImage can get image segments from replied message.
    const taskSystem = new TaskSystem(
      services.taskManager,
      services.hookManager,
      aiService,
      messageAPI,
      databaseManager,
    );
    this.container.registerInstance(DITokens.TASK_SYSTEM, taskSystem, { logRegistration: false });

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
    const aiManager = new AIManager();
    this.container.registerInstance(DITokens.AI_MANAGER, aiManager, { logRegistration: false });

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
   * Creates ThreadService, OllamaAnalysis, etc. from registered tokens (ConversationHistoryService registered earlier)
   * and registers ThreadService + ProactiveConversationService.
   */
  private static configureProactiveConversationService(serviceRegistry: ServiceRegistry): void {
    const { threadService, proactiveConversationService } = this.createProactiveConversationFromContainer();
    serviceRegistry.registerThreadService(threadService);
    serviceRegistry.registerProactiveConversationService(proactiveConversationService);
  }

  /**
   * Register proactive-related dependencies into the container, then resolve ProactiveConversationService.
   * ProactiveConversationService is @injectable(); the container injects all 9 deps into its constructor.
   * Returns threadService and proactiveConversationService for ServiceRegistry registration.
   */
  private static createProactiveConversationFromContainer(): {
    threadService: ThreadService;
    proactiveConversationService: ProactiveConversationService;
  } {
    const databaseManager = this.container.resolve<DatabaseManager>(DITokens.DATABASE_MANAGER);
    const aiManager = this.container.resolve<AIManager>(DITokens.AI_MANAGER);
    const promptManager = this.container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const summarizeService = this.container.resolve<SummarizeService>(DITokens.SUMMARIZE_SERVICE);

    const threadService = new ThreadService();
    this.container.registerInstance(DITokens.THREAD_SERVICE, threadService, { logRegistration: false });
    this.container.registerInstance(
      DITokens.PRELIMINARY_ANALYSIS_SERVICE,
      new PreliminaryAnalysisService(aiManager, promptManager),
      { logRegistration: false },
    );

    // Use SearXNG-based preference knowledge when RetrievalService is available and search enabled.
    // Analysis stage decides searchQueries; retrieve() runs them then one short LLM sufficiency check (option B: supplement search if needed).
    const llmService = this.container.resolve<LLMService>(DITokens.LLM_SERVICE);
    const preferenceKnowledge = this.container.isRegistered(DITokens.RETRIEVAL_SERVICE)
      ? new SearXNGPreferenceKnowledgeService(
          this.container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE),
          llmService,
          promptManager,
        )
      : new DefaultPreferenceKnowledgeService();
    this.container.registerInstance(DITokens.PREFERENCE_KNOWLEDGE_SERVICE, preferenceKnowledge, {
      logRegistration: false,
    });
    this.container.registerInstance(
      DITokens.PROACTIVE_THREAD_PERSISTENCE_SERVICE,
      new DefaultProactiveThreadPersistenceService(databaseManager),
      { logRegistration: false },
    );
    this.container.registerInstance(
      DITokens.THREAD_CONTEXT_COMPRESSION_SERVICE,
      new ThreadContextCompressionService(threadService, summarizeService, promptManager),
      { logRegistration: false },
    );

    // Register class so resolve() creates an instance with injected deps; ServiceRegistry then overwrites with that instance.
    this.container.registerClass(DITokens.PROACTIVE_CONVERSATION_SERVICE, ProactiveConversationService);
    const proactiveConversationService = this.container.resolve<ProactiveConversationService>(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
    );
    const threadServiceResolved = this.container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
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
    const processStageInterceptorRegistry = new ProcessStageInterceptorRegistry();
    this.container.registerInstance(DITokens.PROCESS_STAGE_INTERCEPTOR_REGISTRY, processStageInterceptorRegistry, {
      logRegistration: false,
    });

    // Initialize MessageUtils with command prefixes
    MessageUtils.initialize(['/', '!']);

    const lifecycle = new Lifecycle(services.hookManager, commandRouter, processStageInterceptorRegistry);

    const promptManager = this.container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const pipeline = new MessagePipeline(
      lifecycle,
      services.hookManager,
      apiClient,
      services.contextManager,
      promptManager,
    );
    const conversationManager = new ConversationManager(pipeline);
    this.container.registerInstance(DITokens.CONVERSATION_MANAGER, conversationManager, { logRegistration: false });

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

    // TaskSystem was already created and registered in the container before ProactiveConversationService.
    const taskSystem = this.container.resolve<TaskSystem>(DITokens.TASK_SYSTEM);
    systemRegistry.registerSystemFactory('task', () => taskSystem);

    systemRegistry.registerSystemFactory('database-persistence', () => {
      return new DatabasePersistenceSystem(services.databaseManager);
    });

    const retrievalService = this.container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);
    const ragConfig = config.getRAGConfig();
    systemRegistry.registerSystemFactory('rag-persistence', () => {
      return new RAGPersistenceSystem(retrievalService, ragConfig);
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

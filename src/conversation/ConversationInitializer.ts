// Conversation Initializer - initializes all conversation-related components

import {
  AIManager,
  AIService,
  type CapabilityType,
  LLMService,
  type PromptManager,
  ProviderFactory,
  ProviderSelector,
} from '@/ai';
import { PrefixInvitationCheckService } from '@/ai/services/PrefixInvitationCheckService';
import { PreliminaryAnalysisService } from '@/ai/services/PreliminaryAnalysisService';
import type { APIClient } from '@/api/APIClient';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { CommandManager } from '@/command';
import { DefaultPermissionChecker } from '@/command/PermissionChecker';
import { ContextManager } from '@/context';
import { ConversationConfigService } from '@/conversation/ConversationConfigService';
import { ConversationHistoryService, SessionHistoryStore } from '@/conversation/history';
import type { AIConfig, Config } from '@/core/config';
import { GlobalConfigManager } from '@/core/config/GlobalConfigManager';
import { type DIContainer, getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { type SystemContext, SystemRegistry } from '@/core/system';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/hooks/HookManager';
import { MemoryExtractService, MemoryService } from '@/memory';
import { MessageUtils } from '@/message/MessageUtils';
import { FileReadService } from '@/services/file';
import type { RetrievalService } from '@/services/retrieval';
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
  aiManager: AIManager;
  aiService: AIService;
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
 * 7. System Initialization - Register and initialize business systems
 */
export class ConversationInitializer {
  /**
   * Initialize all conversation components
   */
  static async initialize(config: Config, apiClient: APIClient): Promise<ConversationComponents> {
    const container = getContainer();
    const commandPrefixes = ['/', '!'];

    // Phase 1: Infrastructure Setup
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.registerInfrastructureServices(config, apiClient);

    // Phase 2: Create baseline infra services.
    // DatabaseManager must be initialized before ConversationConfigService.
    const dbConfig = config.getDatabaseConfig();
    const databaseManager = new DatabaseManager();
    await databaseManager.initialize(dbConfig);
    container.registerInstance(DITokens.DATABASE_MANAGER, databaseManager);

    // Memory service persists extracted facts to local files.
    const memoryDir = config.getMemoryConfig().dir;
    const memoryService = new MemoryService({ memoryDir });
    container.registerInstance(DITokens.MEMORY_SERVICE, memoryService);

    // Conversation config services are required by CommandManager.
    const globalConfigManager = new GlobalConfigManager();
    container.registerInstance(DITokens.GLOBAL_CONFIG_MANAGER, globalConfigManager);
    const conversationConfigService = new ConversationConfigService(databaseManager.getAdapter(), globalConfigManager);
    container.registerInstance(DITokens.CONVERSATION_CONFIG_SERVICE, conversationConfigService);

    // Create remaining core services.
    const services = await ConversationInitializer.createCoreServices(
      config,
      conversationConfigService,
      databaseManager,
      container,
    );

    // Phase 3: Service Configuration
    await ConversationInitializer.configureServices(services, config);

    // Phase 3.5: Register AIManager with health check manager
    serviceRegistry.registerAIManagerHealthCheck(services.aiManager);

    // Phase 4: Wire AI-facing services.
    const providerSelector = new ProviderSelector(services.aiManager, conversationConfigService);
    const llmService = new LLMService(services.aiManager, providerSelector);
    container.registerInstance(DITokens.LLM_SERVICE, llmService);

    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    // SummarizeService is reused by context memory and proactive thread compression. Must be registered before ConversationHistoryService (it resolves it in constructor).
    const summarizeService = new SummarizeService(llmService, promptManager);
    container.registerInstance(DITokens.SUMMARIZE_SERVICE, summarizeService);

    const memoryConfig = config.getContextMemoryConfig();
    const useSummary = memoryConfig?.useSummary ?? false;
    const summaryThreshold = memoryConfig?.summaryThreshold ?? 20;
    const maxBufferSize = memoryConfig?.maxBufferSize ?? 30;
    const maxHistoryMessages = memoryConfig?.maxHistoryMessages ?? 10;

    // Conversation history service is shared by reply generation and task analysis flows.
    const conversationHistoryService = new ConversationHistoryService(databaseManager, 30, maxHistoryMessages);
    container.registerInstance(DITokens.CONVERSATION_HISTORY_SERVICE, conversationHistoryService);

    // Memory extraction is triggered by memory-related hooks/tasks.
    const memoryExtractService = new MemoryExtractService(promptManager, llmService, memoryService);
    container.registerInstance(DITokens.MEMORY_EXTRACT_SERVICE, memoryExtractService);

    const sessionHistoryStore = new SessionHistoryStore(maxBufferSize, summaryThreshold, useSummary);
    const contextManager = new ContextManager(sessionHistoryStore);

    // File reading service is used by file-related task executors.
    const fileReadService = new FileReadService(config.getFileReadServiceConfig());
    serviceRegistry.registerFileReadService(fileReadService);

    // AIService is the facade used by systems/hooks for generation and analysis.
    const messageAPI = new MessageAPI(apiClient);
    const retrievalService = container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);
    container.registerInstance(DITokens.MESSAGE_API, messageAPI);
    const aiService = new AIService(
      services.aiManager,
      services.hookManager,
      promptManager,
      services.taskManager,
      conversationHistoryService,
      providerSelector,
      retrievalService,
      memoryService,
      messageAPI,
      databaseManager,
    );
    serviceRegistry.registerAIServiceCapabilities(aiService);

    // TaskSystem must exist before ProactiveConversationService is resolved from DI.
    const taskSystem = new TaskSystem(services.taskManager, services.hookManager, aiService);
    container.registerInstance(DITokens.TASK_SYSTEM, taskSystem);

    // ProactiveConversationService and its dependencies are assembled via container resolution.
    ConversationInitializer.configureProactiveConversationService(container);

    const completeServices: CompleteServices = {
      ...services,
      aiService,
      contextManager,
      conversationConfigService,
      globalConfigManager,
    };
    serviceRegistry.registerConversationServices(completeServices);

    // Phase 6: Component assembly.
    const components = ConversationInitializer.assembleComponents(
      completeServices,
      apiClient,
      commandPrefixes,
      container,
    );

    // Phase 7: Register and initialize business systems.
    await ConversationInitializer.registerAndInitializeSystems(components, completeServices, config, container);

    return components;
  }

  /**
   * Phase 3: Create core service instances.
   * ConversationConfigService is provided because CommandManager depends on it.
   */
  private static async createCoreServices(
    config: Config,
    conversationConfigService: ConversationConfigService,
    databaseManager: DatabaseManager,
    container: DIContainer,
  ): Promise<{
    databaseManager: DatabaseManager;
    aiManager: AIManager;
    commandManager: CommandManager;
    taskManager: TaskManager;
    hookManager: HookManager;
  }> {
    const aiManager = new AIManager();
    container.registerInstance(DITokens.AI_MANAGER, aiManager);

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
    ConversationInitializer.configureAIManager(services.aiManager, config);
    ConversationInitializer.configureTaskManager(services.taskManager);
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

    ConversationInitializer.configureDefaultProviders(aiManager, aiConfig);
  }

  /**
   * Register proactive dependencies and resolve ProactiveConversationService from DI.
   */
  private static configureProactiveConversationService(container: DIContainer): {
    threadService: ThreadService;
    proactiveConversationService: ProactiveConversationService;
  } {
    const databaseManager = container.resolve<DatabaseManager>(DITokens.DATABASE_MANAGER);
    const aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER);
    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const summarizeService = container.resolve<SummarizeService>(DITokens.SUMMARIZE_SERVICE);

    const threadService = new ThreadService();
    container.registerInstance(DITokens.THREAD_SERVICE, threadService);
    container.registerInstance(
      DITokens.PRELIMINARY_ANALYSIS_SERVICE,
      new PreliminaryAnalysisService(aiManager, promptManager),
    );
    container.registerInstance(
      DITokens.PREFIX_INVITATION_CHECK_SERVICE,
      new PrefixInvitationCheckService(aiManager, promptManager),
    );

    // Use SearXNG-backed preference knowledge when RetrievalService is available.
    const llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    const preferenceKnowledge = container.isRegistered(DITokens.RETRIEVAL_SERVICE)
      ? new SearXNGPreferenceKnowledgeService(
          container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE),
          llmService,
          promptManager,
        )
      : new DefaultPreferenceKnowledgeService();
    container.registerInstance(DITokens.PREFERENCE_KNOWLEDGE_SERVICE, preferenceKnowledge);
    container.registerInstance(
      DITokens.PROACTIVE_THREAD_PERSISTENCE_SERVICE,
      new DefaultProactiveThreadPersistenceService(databaseManager),
    );
    container.registerInstance(
      DITokens.THREAD_CONTEXT_COMPRESSION_SERVICE,
      new ThreadContextCompressionService(threadService, summarizeService, promptManager),
    );

    container.registerClass(DITokens.PROACTIVE_CONVERSATION_SERVICE, ProactiveConversationService);
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

    // Log configured defaults to simplify provider setup debugging.
    if (aiConfig.defaultProviders) {
      logger.debug(
        `[ConversationInitializer] defaultProviders from config: ${JSON.stringify(aiConfig.defaultProviders)}`,
      );
    }

    // First pass: respect explicit defaults from config.
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

    // Second pass: use the first available provider for any unset capability.
    for (const capability of validCapabilities) {
      if (aiManager.getDefaultProvider(capability)) {
        continue;
      }

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
  private static configureTaskManager(taskManager: TaskManager): void {
    // Initialize task system - this will auto-register all decorated task executors
    TaskInitializer.initialize(taskManager);
  }

  /**
   * Phase 6: Assemble high-level components.
   */
  private static assembleComponents(
    services: CompleteServices,
    apiClient: APIClient,
    commandPrefixes: string[],
    container: DIContainer,
  ): ConversationComponents {
    const systemRegistry = new SystemRegistry();
    const commandRouter = new CommandRouter(commandPrefixes);
    const processStageInterceptorRegistry = new ProcessStageInterceptorRegistry();
    container.registerInstance(DITokens.PROCESS_STAGE_INTERCEPTOR_REGISTRY, processStageInterceptorRegistry);

    MessageUtils.initialize(commandPrefixes);

    const lifecycle = new Lifecycle(services.hookManager, commandRouter, processStageInterceptorRegistry);

    const pipeline = new MessagePipeline(
      lifecycle,
      services.hookManager,
      apiClient,
      services.contextManager,
      services.conversationConfigService,
    );
    const conversationManager = new ConversationManager(pipeline);
    container.registerInstance(DITokens.CONVERSATION_MANAGER, conversationManager);

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
   * Phase 7: Register and initialize business systems.
   */
  private static async registerAndInitializeSystems(
    components: ConversationComponents,
    services: CompleteServices,
    config: Config,
    container: DIContainer,
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

    // TaskSystem was pre-created before proactive service resolution.
    const taskSystem = container.resolve<TaskSystem>(DITokens.TASK_SYSTEM);
    systemRegistry.registerSystemFactory('task', () => taskSystem);

    systemRegistry.registerSystemFactory('database-persistence', () => {
      return new DatabasePersistenceSystem(services.databaseManager);
    });

    const retrievalService = container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);
    const ragConfig = config.getRAGConfig();
    systemRegistry.registerSystemFactory('rag-persistence', () => {
      return new RAGPersistenceSystem(retrievalService, ragConfig);
    });

    await systemRegistry.createSystems(systemContext);
    await systemRegistry.initializeSystems(systemContext);

    // Register all systems into lifecycle execution.
    const { lifecycle } = components;
    const businessSystems = systemRegistry.getAllSystems();
    for (const system of businessSystems) {
      lifecycle.registerSystem(system);
    }
  }
}

// Conversation Initializer - initializes all conversation-related components

import { AgendaInitializer } from '@/agenda';
import {
  AIManager,
  AIService,
  type CapabilityType,
  LLMService,
  type LLMServiceConfig,
  type PromptManager,
  ProviderFactory,
  ProviderSelector,
} from '@/ai';
import { ProviderRouter } from '@/ai/routing/ProviderRouter';
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
import { type HealthCheckManager, ProviderHealthAdapter } from '@/core/health';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { type SystemContext, SystemRegistry } from '@/core/system';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/hooks/HookManager';
import { MemoryExtractService, MemoryRAGService, MemoryService } from '@/memory';
import { MessageUtils } from '@/message/MessageUtils';
import { BilibiliService } from '@/services/bilibili';
import { FileReadService } from '@/services/file';
import type { RetrievalService } from '@/services/retrieval';
import { ToolInitializer, ToolManager } from '@/tools';
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
import { ReplyPrepareSystem } from './systems/ReplyPrepareSystem';
import { ReplySystem } from './systems/ReplySystem';
import { SendSystem } from './systems/SendSystem';
import { ThreadContextCompressionService, ThreadService } from './thread';

export interface ConversationComponents {
  conversationManager: ConversationManager;
  hookManager: HookManager;
  commandManager: CommandManager;
  toolManager: ToolManager;
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
  toolManager: ToolManager;
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

    // Phase 3.5: Register AIManager with health check manager (for aggregate health)
    serviceRegistry.registerAIManagerHealthCheck(services.aiManager);

    // Phase 3.6: Register each AI provider individually with HealthCheckManager
    // Skip providers that opt out (e.g. serverless providers to avoid cold-start costs)
    const healthCheckManager = container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);
    for (const provider of services.aiManager.getAllProviders()) {
      if (provider.skipHealthCheck) {
        logger.info(`[ConversationInitializer] Skipping health check registration for ${provider.name} (skipHealthCheck=true)`);
        continue;
      }
      const adapter = new ProviderHealthAdapter(provider);
      healthCheckManager.registerService(adapter, { cacheDuration: 60000, timeout: 8000 });
    }

    // NOTE: Startup health check is deferred to bootstrap.ts AFTER plugins are loaded,
    // so that plugins (e.g. CloudflareWorkerProxy) can replace httpClient before checks run.

    // Phase 4: Wire AI-facing services.
    const providerSelector = new ProviderSelector(services.aiManager, conversationConfigService);
    container.registerInstance(DITokens.PROVIDER_SELECTOR, providerSelector);

    const providerRouter = new ProviderRouter(services.aiManager);
    container.registerInstance(DITokens.PROVIDER_ROUTER, providerRouter);

    // Build LLM service config from AI config
    const aiConfig = config.getAIConfig();
    if (!aiConfig?.llmFallback) {
      throw new Error('[ConversationInitializer] ai.llmFallback is required in config');
    }
    const llmServiceConfig: LLMServiceConfig = {
      toolUseProviders: aiConfig.toolUseProviders ?? [],
      fallback: aiConfig.llmFallback,
      rateLimit: aiConfig.rateLimit
        ? {
            defaultTokensPerMinute: aiConfig.rateLimit.defaultTokensPerMinute ?? 0,
            providers: aiConfig.rateLimit.providers,
          }
        : undefined,
    };

    const llmService = new LLMService(services.aiManager, providerSelector, healthCheckManager, llmServiceConfig);
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

    // Configure Memory RAG if RAG is enabled - enables semantic search for memory filtering
    const ragService = retrievalService.getRAGService();
    if (ragService) {
      const memoryRAGService = new MemoryRAGService(ragService);
      memoryService.setRAGService(memoryRAGService);
      logger.info('[ConversationInitializer] Memory RAG enabled for semantic memory filtering');
    }

    const aiService = new AIService(
      services.aiManager,
      services.hookManager,
      promptManager,
      services.toolManager,
      conversationHistoryService,
      providerSelector,
      retrievalService,
      memoryService,
      messageAPI,
      databaseManager,
      llmService,
      providerRouter,
      {
        providerName: aiConfig.taskProviders?.subagent,
        model: aiConfig.taskProviders?.subagentModel,
      },
    );
    serviceRegistry.registerAIServiceCapabilities(aiService);
    // Expose SubAgentManager to DI so tool executors (e.g. ResearchToolExecutor) can inject it.
    container.registerInstance(DITokens.SUB_AGENT_MANAGER, aiService.getSubAgentManager());

    // ReplySystem must exist before ProactiveConversationService is resolved from DI.
    const useSkills = config.getUseSkills();
    if (!useSkills) {
      logger.warn('[ConversationInitializer] ai.useSkills=false is no longer supported; forcing skill-loop reply flow');
    }
    const replySystem = new ReplySystem(aiService);
    container.registerInstance(DITokens.REPLY_SYSTEM, replySystem);

    // ProactiveConversationService and its dependencies are assembled via container resolution.
    ConversationInitializer.configureProactiveConversationService(container);

    // Agenda framework: AgendaService + AgentLoop + InternalEventBus.
    // With toolManager/hookManager, AgentLoop uses generateWithTools for plan→tool→message.
    const agendaComponents = await AgendaInitializer.initialize({
      databaseManager,
      llmService: container.resolve<LLMService>(DITokens.LLM_SERVICE),
      messageAPI,
      conversationHistoryService,
      promptManager: container.resolve<PromptManager>(DITokens.PROMPT_MANAGER),
      toolManager: services.toolManager,
      hookManager: services.hookManager,
      aiService,
    });
    serviceRegistry.registerAgendaServices(agendaComponents);

    const completeServices: CompleteServices = {
      ...services,
      aiService,
      contextManager,
      conversationConfigService,
      globalConfigManager,
    };
    serviceRegistry.registerConversationServices(completeServices);

    // Phase 6: Component assembly.
    const components = ConversationInitializer.assembleComponents(completeServices, commandPrefixes, container);

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
    toolManager: ToolManager;
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

    // Register BilibiliService (used by bilibili command and tool executor)
    const bilibiliService = new BilibiliService();
    container.registerInstance('BilibiliService', bilibiliService);

    const toolManager = new ToolManager();
    const hookManager = new HookManager();

    return {
      databaseManager,
      aiManager,
      commandManager,
      toolManager,
      hookManager,
    };
  }

  /**
   * Phase 3: Configure services (providers, executors, etc.)
   */
  private static async configureServices(
    services: {
      aiManager: AIManager;
      toolManager: ToolManager;
    },
    config: Config,
  ): Promise<void> {
    ConversationInitializer.configureAIManager(services.aiManager, config);
    ConversationInitializer.configureToolManager(services.toolManager);
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
    // Get summarize provider from config
    const config = container.resolve<Config>(DITokens.CONFIG);
    const summarizeProvider =
      config.getAIConfig()?.taskProviders?.summarize ?? config.getAIConfig()?.defaultProviders?.llm;
    container.registerInstance(
      DITokens.THREAD_CONTEXT_COMPRESSION_SERVICE,
      new ThreadContextCompressionService(threadService, summarizeService, promptManager, summarizeProvider),
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
   * Task registration is handled by ToolInitializer using decorators
   */
  private static configureToolManager(toolManager: ToolManager): void {
    // Initialize task system - this will auto-register all decorated task executors
    ToolInitializer.initialize(toolManager);
  }

  /**
   * Phase 6: Assemble high-level components.
   */
  private static assembleComponents(
    services: CompleteServices,
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
      services.contextManager,
      services.conversationConfigService,
    );
    const conversationManager = new ConversationManager(pipeline);
    container.registerInstance(DITokens.CONVERSATION_MANAGER, conversationManager);

    return {
      conversationManager,
      hookManager: services.hookManager,
      commandManager: services.commandManager,
      toolManager: services.toolManager,
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

    // ReplySystem was pre-created before proactive service resolution.
    const replySystem = container.resolve<ReplySystem>(DITokens.REPLY_SYSTEM);
    systemRegistry.registerSystemFactory('reply', () => replySystem);

    systemRegistry.registerSystemFactory('reply-prepare', () => {
      return new ReplyPrepareSystem();
    });

    const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
    systemRegistry.registerSystemFactory('send', () => {
      return new SendSystem(messageAPI, services.hookManager);
    });

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

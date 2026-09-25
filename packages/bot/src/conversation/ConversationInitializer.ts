// Conversation Initializer - initializes all conversation-related components

import { AgendaInitializer } from '@/agenda';
import type { AIManager, PromptManager } from '@/ai';
import { AIService } from '@/ai/AIService';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { CommandManager } from '@/command';
import { ContextManager } from '@/context/ContextManager';
import { ConversationConfigService } from '@/conversation/ConversationConfigService';
import { Lifecycle } from '@/conversation/Lifecycle';
import { ReplySystem } from '@/conversation/systems/ReplySystem';
import type { Config } from '@/core/config';
import { GlobalConfigManager } from '@/core/config/GlobalConfigManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { ProviderHealthAdapter } from '@/core/health';
import { HealthCheckManager } from '@/core/health/HealthCheckManager';
import { type SystemContext, SystemRegistry } from '@/core/system';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/hooks/HookManager';
import { MemoryRAGService } from '@/memory';
import { MemoryService } from '@/memory/MemoryService';
import { MessageUtils } from '@/message/MessageUtils';
import { PersonaInitializer } from '@/persona';
import { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { ToolManager } from '@/tools';
import { logger } from '@/utils/logger';
import { COMMAND_PREFIXES } from './CommandRouter';
import { ConversationManager } from './ConversationManager';
import { CommandSystem } from './systems/CommandSystem';
import { DatabasePersistenceSystem } from './systems/DatabasePersistenceSystem';
import { RAGPersistenceSystem } from './systems/RAGPersistenceSystem';
import { ReplyPrepareSystem } from './systems/ReplyPrepareSystem';
import { SendSystem } from './systems/SendSystem';

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
 * Startup steps of the conversation system: connect the database, migrate, register the
 * stores that depend on the adapter, start agenda and persona, assemble the components and
 * initialize the business systems.
 */
export class ConversationInitializer {
  /**
   * Startup steps of the conversation system, in the order their side effects need. Every
   * service is a DI singleton built on first resolve; this method only connects, migrates,
   * attaches and assembles.
   */
  static async initialize(config: Config): Promise<ConversationComponents> {
    const container = getContainer();

    // Connect first: every provider that reads the adapter is built after this line.
    const databaseManager = container.resolve(DatabaseManager);
    await databaseManager.initialize(config.getDatabaseConfig());

    // Auto-migrate legacy single-file memory format to new directory structure
    const memoryService = container.resolve(MemoryService);
    await memoryService.migrateLegacyFiles();

    await ConversationInitializer.registerSqliteStores(databaseManager);
    ConversationInitializer.attachMemoryRag(config, memoryService);
    ConversationInitializer.registerAIHealthChecks();

    // Agenda framework: AgendaService + AgentLoop + InternalEventBus.
    const agendaComponents = await AgendaInitializer.initialize({
      config,
      databaseManager,
      promptManager: container.resolve<PromptManager>(DITokens.PROMPT_MANAGER),
    });
    container.registerInstance(DITokens.AGENDA_SERVICE, agendaComponents.agendaService);
    container.registerInstance(DITokens.AGENT_LOOP, agendaComponents.agentLoop);
    container.registerInstance(DITokens.INTERNAL_EVENT_BUS, agendaComponents.internalEventBus);
    container.registerInstance(DITokens.AGENDA_REPORTER, agendaComponents.reporter);
    container.registerInstance(DITokens.SCHEDULE_FILE_SERVICE, agendaComponents.scheduleFileService);

    // Mind framework: phenotype ODE + modulation adapter for avatar.
    // Must run AFTER agenda so it can share the same InternalEventBus;
    // bootstrap wires personaService.start() + pose provider + avatar
    // modulation injection after AvatarService is ready.
    const mindComponents = await PersonaInitializer.initialize({
      rawConfig: config.getPersonaConfig(),
      internalEventBus: agendaComponents.internalEventBus,
    });
    container.registerInstance(DITokens.PERSONA_SERVICE, mindComponents.personaService);
    container.registerInstance(DITokens.PERSONA_CONFIG, mindComponents.config);
    container.registerInstance(DITokens.PERSONA_MODULATION_PROVIDER, mindComponents.modulationProvider);

    const services: CompleteServices = {
      databaseManager,
      aiManager: container.resolve<AIManager>(DITokens.AI_MANAGER),
      aiService: container.resolve(AIService),
      contextManager: container.resolve(ContextManager),
      commandManager: container.resolve(CommandManager),
      toolManager: container.resolve<ToolManager>(DITokens.TOOL_MANAGER),
      hookManager: container.resolve(HookManager),
      conversationConfigService: container.resolve(ConversationConfigService),
      globalConfigManager: container.resolve(GlobalConfigManager),
    };

    const components = ConversationInitializer.assembleComponents(services);
    await ConversationInitializer.registerAndInitializeSystems(components, services, config);
    return components;
  }

  /**
   * SQLite-backed stores: registered only when the adapter is SQLite (SessionMemoStore
   * falls back to memory otherwise), which is known only after the database connects.
   */
  private static async registerSqliteStores(databaseManager: DatabaseManager): Promise<void> {
    const container = getContainer();
    // Memory fact metadata service (quality tracking for memory facts via SQLite)
    try {
      const { SQLiteAdapter } = await import('@/database/adapters/SQLiteAdapter');
      const adapter = databaseManager.getAdapter();
      if (adapter instanceof SQLiteAdapter) {
        const rawDb = adapter.getRawDb();
        if (rawDb) {
          const { MemoryFactMetaService } = await import('@/memory/MemoryFactMetaService');
          const memoryFactMetaService = new MemoryFactMetaService(rawDb);
          container.registerInstance(DITokens.MEMORY_FACT_META_SERVICE, memoryFactMetaService);
          logger.info('[ConversationInitializer] MemoryFactMetaService registered');
        }
      }
    } catch (err) {
      logger.debug('[ConversationInitializer] MemoryFactMetaService not available (non-SQLite or init error):', err);
    }

    // EpigeneticsStore — Mind Phase 2 relationship + epigenetics persistence (SQLite only).
    try {
      const { SQLiteAdapter } = await import('@/database/adapters/SQLiteAdapter');
      const adapter = databaseManager.getAdapter();
      if (adapter instanceof SQLiteAdapter) {
        const rawDb = adapter.getRawDb();
        if (rawDb) {
          const { EpigeneticsStore } = await import('@/persona/reflection/epigenetics/EpigeneticsStore');
          const epigeneticsStore = new EpigeneticsStore(rawDb);
          container.registerInstance(DITokens.EPIGENETICS_STORE, epigeneticsStore);
          logger.info('[ConversationInitializer] EpigeneticsStore registered');
        }
      }
    } catch (err) {
      logger.debug('[ConversationInitializer] EpigeneticsStore not available (non-SQLite or init error):', err);
    }

    // SessionMemoStore — LLM-writable per-session memo blackboard.
    // Uses SQLite raw db when available; falls back to in-memory otherwise.
    // Unlike EpigeneticsStore this store is ALWAYS registered (in-memory when
    // SQLite is unavailable) because the session_memo tool must always be
    // callable regardless of the configured DB backend.
    {
      let sessionMemoRawDb: import('bun:sqlite').Database | null = null;
      try {
        const { SQLiteAdapter } = await import('@/database/adapters/SQLiteAdapter');
        const adapter = databaseManager.getAdapter();
        if (adapter instanceof SQLiteAdapter) {
          sessionMemoRawDb = adapter.getRawDb();
        }
      } catch (err) {
        logger.debug('[ConversationInitializer] SessionMemoStore SQLite probe failed, using in-memory:', err);
      }
      const { SessionMemoStore } = await import('@/conversation/memo/SessionMemoStore');
      container.registerInstance(DITokens.SESSION_MEMO_STORE, new SessionMemoStore(sessionMemoRawDb));
      logger.info(
        `[ConversationInitializer] SessionMemoStore registered (persistence=${sessionMemoRawDb ? 'sqlite' : 'memory'})`,
      );
    }
  }

  /** Semantic memory filtering over the RAG backend, when RAG is configured. */
  private static attachMemoryRag(config: Config, memoryService: MemoryService): void {
    const container = getContainer();
    // Configure Memory RAG if RAG is enabled - enables semantic search for memory filtering
    const ragService = container.resolve(RetrievalService).getRAGService();
    if (ragService) {
      const memoryRAGService = new MemoryRAGService(ragService);
      // Wire up MemoryFactMetaService for incremental diff indexing
      try {
        const factMetaService = container.resolve<import('@/memory/MemoryFactMetaService').MemoryFactMetaService>(
          DITokens.MEMORY_FACT_META_SERVICE,
        );
        memoryRAGService.setFactMetaService(factMetaService);
        memoryService.setFactMetaService(factMetaService);
      } catch {
        logger.debug('[ConversationInitializer] MemoryFactMetaService not available, using legacy RAG indexing');
      }
      memoryService.setRAGService(memoryRAGService);
      // Apply quality scoring config if present
      const scoringConfig = config.getMemoryConfig().qualityScoring;
      if (scoringConfig) {
        memoryService.setScoringConfig(scoringConfig);
      }
      logger.info('[ConversationInitializer] Memory RAG enabled for semantic memory filtering');
    }
  }

  /** AIManager aggregate health plus one check per provider that has not opted out. */
  private static registerAIHealthChecks(): void {
    const container = getContainer();
    // Register AIManager with health check manager (for aggregate health; it checks
    // every provider it manages).
    const healthCheckManager = container.resolve(HealthCheckManager);
    const aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER);
    healthCheckManager.registerService(aiManager, {
      cacheDuration: 120000, // AI providers are usually stable
      timeout: 10000,
      retries: 0,
      checkInterval: 3600000,
    });

    // Register each AI provider individually with HealthCheckManager
    // Skip providers that opt out (e.g. serverless providers to avoid cold-start costs)
    for (const provider of aiManager.getAllProviders()) {
      if (provider.skipHealthCheck) {
        logger.info(
          `[ConversationInitializer] Skipping health check registration for ${provider.name} (skipHealthCheck=true)`,
        );
        continue;
      }
      const adapter = new ProviderHealthAdapter(provider);
      healthCheckManager.registerService(adapter, { cacheDuration: 60000, timeout: 8000 });
    }

    // NOTE: Startup health check is deferred to bootstrap.ts AFTER plugins are loaded,
    // so that plugins (e.g. CloudflareWorkerProxy) can replace httpClient before checks run.
  }

  /**
   * Assemble high-level components.
   */
  private static assembleComponents(services: CompleteServices): ConversationComponents {
    const container = getContainer();
    MessageUtils.initialize(COMMAND_PREFIXES);
    return {
      conversationManager: container.resolve(ConversationManager),
      hookManager: services.hookManager,
      commandManager: services.commandManager,
      toolManager: services.toolManager,
      contextManager: services.contextManager,
      databaseManager: services.databaseManager,
      systemRegistry: new SystemRegistry(),
      lifecycle: container.resolve(Lifecycle),
    };
  }

  /**
   * Register and initialize business systems.
   */
  private static async registerAndInitializeSystems(
    components: ConversationComponents,
    services: CompleteServices,
    config: Config,
  ): Promise<void> {
    const container = getContainer();
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

    const replySystem = container.resolve(ReplySystem);
    systemRegistry.registerSystemFactory('reply', () => replySystem);

    systemRegistry.registerSystemFactory('reply-prepare', () => {
      return new ReplyPrepareSystem();
    });

    const messageAPI = container.resolve(MessageAPI);
    systemRegistry.registerSystemFactory('send', () => {
      return new SendSystem(messageAPI, services.hookManager);
    });

    systemRegistry.registerSystemFactory('database-persistence', () => {
      return new DatabasePersistenceSystem(services.databaseManager);
    });

    const retrievalService = container.resolve(RetrievalService);
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

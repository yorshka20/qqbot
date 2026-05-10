// Service Registry - manages service registration to DI container
// Provides a clear, organized way to register services with proper lifecycle management

import type { AgendaComponents } from '@/agenda';
import type { AIManager } from '@/ai/AIManager';
import type { AIService } from '@/ai/AIService';
import type { APIClient } from '@/api/APIClient';
import type { CommandManager } from '@/command/CommandManager';
import type { ContextManager } from '@/context/ContextManager';
import type { ProactiveConversationService } from '@/conversation/proactive';
import type { ThreadService } from '@/conversation/thread';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { PersonaComponents } from '@/persona';
import type { FileReadService } from '@/services/file';
import type { RetrievalService } from '@/services/retrieval';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { Config } from './config';
import { getContainer } from './DIContainer';
import { DITokens, getRequiredTokens, getTokenMeta } from './DITokens';
import type { HealthCheckManager } from './health';

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
    this.container.registerInstance(DITokens.CONFIG, config);
    this.container.registerInstance(DITokens.API_CLIENT, apiClient);
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
  registerToolService(toolManager: ToolManager): void {
    this.container.registerInstance(DITokens.TOOL_MANAGER, toolManager);
  }

  /**
   * Register hook service
   */
  registerHookService(hookManager: HookManager): void {
    this.container.registerInstance(DITokens.HOOK_MANAGER, hookManager);
  }

  /**
   * Register retrieval service (search + RAG)
   */
  registerRetrievalService(retrievalService: RetrievalService): void {
    this.container.registerInstance(DITokens.RETRIEVAL_SERVICE, retrievalService);
  }

  /**
   * Register file read service (for read_file task and ls/cat commands)
   */
  registerFileReadService(fileReadService: FileReadService): void {
    this.container.registerInstance(DITokens.FILE_READ_SERVICE, fileReadService);
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
    // HEALTH_CHECK_MANAGER is required (DITokens.ts) — bootstrap registers
    // it before ConversationInitializer runs.
    const healthManager = this.container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);

    // Register AIManager itself (it will check all its providers)
    healthManager.registerService(aiManager, {
      cacheDuration: 120000, // Cache for 2 minutes (AI providers are usually stable)
      timeout: 10000, // 10 second timeout for checking all providers
      retries: 0, // No retries for health checks
      checkInterval: 3600000, // Auto health check every 1 hour
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
    toolManager: ToolManager;
    hookManager: HookManager;
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
    this.registerToolService(services.toolManager);
    this.registerHookService(services.hookManager);
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
   * Register agenda framework services (AgendaService, AgentLoop, InternalEventBus).
   * Called from ConversationInitializer after agenda components are initialized.
   */
  registerAgendaServices(components: AgendaComponents): void {
    this.container.registerInstance(DITokens.AGENDA_SERVICE, components.agendaService);
    this.container.registerInstance(DITokens.AGENT_LOOP, components.agentLoop);
    this.container.registerInstance(DITokens.INTERNAL_EVENT_BUS, components.internalEventBus);
    this.container.registerInstance(DITokens.AGENDA_REPORTER, components.reporter);
    this.container.registerInstance(DITokens.SCHEDULE_FILE_SERVICE, components.scheduleFileService);
    logger.debug('[ServiceRegistry] Registered agenda framework services');
  }

  /**
   * Register mind subsystem services. Called from ConversationInitializer
   * after mind is constructed (requires InternalEventBus to be available,
   * so must run after `registerAgendaServices`).
   */
  registerPersonaServices(components: PersonaComponents): void {
    this.container.registerInstance(DITokens.PERSONA_SERVICE, components.personaService);
    this.container.registerInstance(DITokens.PERSONA_CONFIG, components.config);
    this.container.registerInstance(DITokens.PERSONA_MODULATION_PROVIDER, components.modulationProvider);
    logger.debug('[ServiceRegistry] Registered mind subsystem services');
  }

  /**
   * Verify every required-by-contract token is registered. Throws on failure
   * so `bun run smoke-test` (and bootstrap) fail loud instead of degrading
   * silently into runtime null-deref later.
   *
   * Optional tokens (gated by config / adapter) are intentionally skipped —
   * see `DITokens.ts` for the contract.
   */
  verifyServices(): void {
    const required = getRequiredTokens();
    const missing: string[] = [];
    for (const token of required) {
      if (!this.container.isRegistered(token)) {
        missing.push(token);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `[ServiceRegistry] Bootstrap left required DI tokens unregistered: ${missing.join(', ')}. ` +
          'Either fix the registration order or, if the token is feature-gated, mark it ' +
          '`required: false, gatedBy: ...` in DITokens.ts.',
      );
    }

    // Surface optional tokens that did not register so operators have a single
    // line summarizing what's gated off in this run.
    const skipped: string[] = [];
    for (const token of Object.values(DITokens)) {
      const meta = getTokenMeta(token);
      if (meta && !meta.required && !this.container.isRegistered(token)) {
        skipped.push(`${token} (${meta.gatedBy})`);
      }
    }
    if (skipped.length > 0) {
      logger.debug(`[ServiceRegistry] Optional tokens not registered: ${skipped.join('; ')}`);
    }
    logger.debug('[ServiceRegistry] All required services are registered');
  }
}

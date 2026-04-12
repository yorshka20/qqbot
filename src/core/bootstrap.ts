// Shared application bootstrap — single source of truth for initialization order.
//
// Both src/index.ts (production) and src/cli/smoke-test.ts (CI validation) call
// this function so that the initialization sequence can never drift between them.
//
// Only steps that require live network I/O are left to callers:
//   bot.start(), MCPInitializer.connectServers(), ClaudeCodeInitializer.start(),
//   and process signal handlers.

import { PromptInitializer } from '@/ai/prompt/PromptInitializer';
import { APIClient } from '@/api/APIClient';
import { ClusterManager, parseClusterConfig, wireClusterEscalation, wireClusterTicketWriteback } from '@/cluster';
import type { ConversationComponents } from '@/conversation/ConversationInitializer';
import { ConversationInitializer } from '@/conversation/ConversationInitializer';
import { Bot } from '@/core/Bot';
import type { ProtocolConfig } from '@/core/config';
import type { Connection } from '@/core/connection';
import { WebSocketConnection } from '@/core/connection';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HealthCheckManager } from '@/core/health';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { EventInitializer } from '@/events/EventInitializer';
import type { EventRouter } from '@/events/EventRouter';
import { PluginInitializer } from '@/plugins/PluginInitializer';
import { DiscordConnection } from '@/protocol/discord/DiscordConnection';
import { ProtocolAdapterInitializer } from '@/protocol/ProtocolAdapterInitializer';
import { ClaudeCodeInitializer } from '@/services/claudeCode';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import type { MCPSystem } from '@/services/mcp/MCPInitializer';
import { MCPInitializer } from '@/services/mcp/MCPInitializer';
import { RetrievalService } from '@/services/retrieval';
import { initStaticServer } from '@/services/staticServer';
import { logger } from '@/utils/logger';
import { registerConnectionClass } from './connection/ConnectionManager';

export interface BootstrapResult {
  bot: Bot;
  mcpSystem: MCPSystem | null;
  claudeCodeService: ClaudeCodeService | null;
  clusterManager: ClusterManager | null;
  conversationComponents: ConversationComponents;
  eventRouter: EventRouter;
  retrievalService: RetrievalService;
}

/**
 * Bootstrap the application: initialize all services, DI registrations, and plugins.
 *
 * Covers every initialization step that does NOT require live network I/O:
 *   Config → API client → Prompt → Plugin factory → MCP init →
 *   Health/Retrieval → Static server → Claude Code init →
 *   Conversation system → Event system → Service registry verify →
 *   Protocol adapter registration → Plugin load
 *
 * Callers only need to handle actual connections afterwards:
 *   bot.start(), MCPInitializer.connectServers(), ClaudeCodeInitializer.start(),
 *   and process signal handlers.
 */
export interface BootstrapOptions {
  /**
   * Skip plugin onEnable (server start / port binding).
   * When true, plugins still run onInit (DI registration) but do not start
   * servers or bind ports. Used by smoke-test to avoid port conflicts.
   */
  skipPluginEnable?: boolean;
}

export async function bootstrapApp(configPath?: string, options?: BootstrapOptions): Promise<BootstrapResult> {
  // ── Config & basic setup ──
  const bot = new Bot(configPath);
  const config = bot.getConfig();
  const container = getContainer();

  const apiConfig = config.getAPIConfig();
  const apiClient = new APIClient(apiConfig.strategy, apiConfig.preferredProtocol);

  // ── Prompt system ──
  PromptInitializer.initialize(config);

  // ── Plugin factory registration (must run BEFORE ConversationInitializer) ──
  PluginInitializer.initialize(config);

  // ── MCP system (sync init only, no server connections) ──
  const mcpSystem = MCPInitializer.initialize(config);

  // ── Health + Retrieval ──
  const healthCheckManager = new HealthCheckManager();
  container.registerInstance(DITokens.HEALTH_CHECK_MANAGER, healthCheckManager);
  const mcpConfig = config.getMCPConfig();
  const ragConfig = config.getRAGConfig();
  const retrievalService = new RetrievalService(mcpConfig, ragConfig, healthCheckManager);
  container.registerInstance(DITokens.RETRIEVAL_SERVICE, retrievalService);
  if (ragConfig?.enabled) {
    logger.info(
      `[Bootstrap] RAG enabled | ollama=${ragConfig.ollama?.url} model=${ragConfig.ollama?.model} qdrant=${ragConfig.qdrant?.url}`,
    );
  }

  // ── StaticServer (local HTTP + backends; must precede ConversationInitializer — ImageGenerationService needs it) ──
  // Optional: `lanRelay.*.disabledStaticBackends` omits specific backend modules (see createBackends registry).
  const staticServerConfig = config.getStaticServerConfig();
  if (staticServerConfig) {
    const disabledBackendIds = config.getDisabledStaticBackendIds();
    await initStaticServer(staticServerConfig, { disabledBackendIds });
  }

  // ── ProjectRegistry (independent, before ClaudeCode so it can be resolved by both) ──
  const projectRegistry = new ProjectRegistry(config.getProjectRegistryConfig());
  container.registerInstance(DITokens.PROJECT_REGISTRY, projectRegistry);
  logger.info('[Bootstrap] ProjectRegistry initialized');

  // ── Claude Code init (sync, no connections) ──
  const claudeCodeService = ClaudeCodeInitializer.initialize(config);

  // ── Agent Cluster init (sync, no connections) ──
  let clusterManager: ClusterManager | null = null;
  const clusterRawConfig = config.getClusterConfig();
  const clusterConfig = parseClusterConfig(clusterRawConfig);

  // ── Conversation system (tools, hooks, commands, AI, DB, context, agenda) ──
  const conversationComponents = await ConversationInitializer.initialize(config, apiClient);

  // ── Agent Cluster (after DB is ready) ──
  if (clusterConfig) {
    try {
      const { DatabaseManager } = await import('@/database/DatabaseManager');
      const { SQLiteAdapter } = await import('@/database/adapters/SQLiteAdapter');
      const dbManager = container.resolve<InstanceType<typeof DatabaseManager>>(DITokens.DATABASE_MANAGER);
      const adapter = dbManager.getAdapter();
      if (!(adapter instanceof SQLiteAdapter)) {
        throw new Error('[Bootstrap] Agent Cluster requires SQLite database adapter');
      }
      const rawDb = adapter.getRawDb();
      if (!rawDb) {
        throw new Error('[Bootstrap] Agent Cluster requires SQLite — raw DB not available');
      }
      const projectRegistry = container.resolve<
        InstanceType<typeof import('@/services/claudeCode/ProjectRegistry').ProjectRegistry>
      >(DITokens.PROJECT_REGISTRY);
      clusterManager = new ClusterManager(clusterConfig, rawDb, projectRegistry);
      container.registerInstance(DITokens.CLUSTER_MANAGER, clusterManager);

      await wireClusterEscalation(clusterManager, config);
      wireClusterTicketWriteback(clusterManager);

      logger.info('[Bootstrap] Agent Cluster initialized');
    } catch (err) {
      logger.error('[Bootstrap] Failed to initialize Agent Cluster:', err);
    }
  }

  // ── Retrieval health check (after HealthCheckManager is created) ──
  retrievalService.registerHealthCheck();

  // ── Event system ──
  const eventSystem = EventInitializer.initialize(
    config,
    conversationComponents.conversationManager,
    conversationComponents.hookManager,
  );
  const eventRouter = eventSystem.eventRouter;
  container.registerInstance(DITokens.EVENT_ROUTER, eventRouter);

  // ── Service registry verification ──
  new ServiceRegistry().verifyServices();

  // ── Protocol adapter registration (registers event listeners, no connections) ──
  const connectionManager = bot.getConnectionManager();
  const connectionTypeMap: Record<string, new (cfg: ProtocolConfig) => Connection> = {
    websocket: WebSocketConnection,
    discord: DiscordConnection,
  };
  for (const protocol of config.getProtocolsToConnect()) {
    const type = protocol.connectionType;
    const ctor = connectionTypeMap[type];
    if (ctor) {
      registerConnectionClass(protocol.name, ctor);
    } else {
      logger.warn(`[Bootstrap] Unknown connectionType "${type}" for protocol "${protocol.name}"`);
    }
  }
  ProtocolAdapterInitializer.initialize(config, connectionManager, eventRouter, apiClient);

  // ── Load plugins (triggers onInit for all enabled plugins, e.g. WeChatIngestPlugin DI registration) ──
  await PluginInitializer.loadPlugins(config, { skipEnable: options?.skipPluginEnable });

  // ── Startup health check (AFTER plugins, so plugins like CloudflareWorkerProxy can replace httpClient first) ──
  healthCheckManager
    .checkAllServices({ force: true })
    .then((results) => {
      let healthy = 0;
      let unhealthy = 0;
      for (const result of results.values()) {
        if (result.status === 'healthy') healthy++;
        else unhealthy++;
      }
      logger.info(`[Bootstrap] Startup health check: ${healthy}/${results.size} providers healthy`);
      if (unhealthy > 0) {
        const unhealthyNames = [...results.entries()].filter(([_, r]) => r.status !== 'healthy').map(([n]) => n);
        logger.warn(`[Bootstrap] Unhealthy providers: ${unhealthyNames.join(', ')}`);
      }
    })
    .catch((err: Error) => {
      logger.warn('[Bootstrap] Startup health check failed:', err);
    });

  logger.info('[Bootstrap] All initialization stages completed');

  return {
    bot,
    mcpSystem,
    claudeCodeService,
    clusterManager,
    conversationComponents,
    eventRouter,
    retrievalService,
  };
}

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
import type { ConversationComponents } from '@/conversation/ConversationInitializer';
import { ConversationInitializer } from '@/conversation/ConversationInitializer';
import { Bot } from '@/core/Bot';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HealthCheckManager } from '@/core/health';
import { ServiceRegistry } from '@/core/ServiceRegistry';
import { EventInitializer } from '@/events/EventInitializer';
import type { EventRouter } from '@/events/EventRouter';
import { PluginInitializer } from '@/plugins/PluginInitializer';
import { ProtocolAdapterInitializer } from '@/protocol/ProtocolAdapterInitializer';
import { ClaudeCodeInitializer } from '@/services/claudeCode';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import type { MCPSystem } from '@/services/mcp/MCPInitializer';
import { MCPInitializer } from '@/services/mcp/MCPInitializer';
import { RetrievalService } from '@/services/retrieval';
import { initStaticFileServer } from '@/services/staticServer';
import { logger } from '@/utils/logger';

export interface BootstrapResult {
  bot: Bot;
  mcpSystem: MCPSystem | null;
  claudeCodeService: ClaudeCodeService | null;
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

  // ── Static file server (must precede ConversationInitializer — ImageGenerationService needs it) ──
  const staticServerConfig = config.getStaticServerConfig();
  if (staticServerConfig) {
    await initStaticFileServer(staticServerConfig);
  }

  // ── Claude Code init (sync, no connections) ──
  const claudeCodeService = ClaudeCodeInitializer.initialize(config);

  // ── Conversation system (tools, hooks, commands, AI, DB, context, agenda) ──
  const conversationComponents = await ConversationInitializer.initialize(config, apiClient);

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
  ProtocolAdapterInitializer.initialize(config, connectionManager, eventRouter, apiClient);

  // ── Load plugins (triggers onInit for all enabled plugins, e.g. WeChatIngestPlugin DI registration) ──
  await PluginInitializer.loadPlugins(config, { skipEnable: options?.skipPluginEnable });

  logger.info('[Bootstrap] All initialization stages completed');

  return {
    bot,
    mcpSystem,
    claudeCodeService,
    conversationComponents,
    eventRouter,
    retrievalService,
  };
}

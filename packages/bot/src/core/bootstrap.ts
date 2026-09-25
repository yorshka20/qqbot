// Shared application bootstrap — single source of truth for initialization order.
//
// Called only through startApp() (core/app.ts), which production, the smoke test and
// the debug CLI all use, so the initialization sequence can never drift between them.
// Everything that opens a live connection belongs to startApp's connect phase instead.

import { AvatarService } from '@qqbot/avatar';
import { PromptInitializer } from '@/ai/prompt/PromptInitializer';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { createBaselineProducer } from '@/ai/prompt/producers/BaselineProducer';
import { createFaceUsageProducer } from '@/ai/prompt/producers/FaceUsageProducer';
import { createModelIdentityProducer } from '@/ai/prompt/producers/ModelIdentityProducer';
import { createProviderPatchProducer } from '@/ai/prompt/producers/ProviderPatchProducer';
import { createSceneProducer } from '@/ai/prompt/producers/SceneProducer';
import { createToolInstructProducer } from '@/ai/prompt/producers/ToolInstructProducer';
import { APIClient } from '@/api/APIClient';
import { ClusterManager, parseClusterConfig, wireClusterEscalation, wireClusterTicketWriteback } from '@/cluster';
import type { ConversationComponents } from '@/conversation/ConversationInitializer';
import { ConversationInitializer } from '@/conversation/ConversationInitializer';
import { MessagePipeline } from '@/conversation/MessagePipeline';
import { ProcessStageInterceptorRegistry } from '@/conversation/ProcessStageInterceptor';
import { PromptInjectionRegistry } from '@/conversation/promptInjection/PromptInjectionRegistry';
import { AdminAlertService } from '@/core/alert/AdminAlertService';
import { Bot } from '@/core/Bot';
import type { ProtocolConfig } from '@/core/config';
import type { Connection } from '@/core/connection';
import { WebSocketConnection } from '@/core/connection';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HealthCheckManager } from '@/core/health/HealthCheckManager';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { EventInitializer } from '@/events/EventInitializer';
import type { EventRouter } from '@/events/EventRouter';
import { LivemodeInterceptor } from '@/integrations/avatar/livemode/LivemodeInterceptor';
import { type PersonaModulationAdapter, type PersonaService, startPersonaSubsystem } from '@/persona';
import { PluginInitializer } from '@/plugins/PluginInitializer';
import { DiscordConnection } from '@/protocol/discord/DiscordConnection';
import { ProtocolAdapterInitializer } from '@/protocol/ProtocolAdapterInitializer';
import { BilibiliLiveBridge } from '@/services/bilibili/live/BilibiliLiveBridge';
import { BilibiliLiveClient } from '@/services/bilibili/live/BilibiliLiveClient';
import { DanmakuBuffer } from '@/services/bilibili/live/DanmakuBuffer';
import { DanmakuStore } from '@/services/bilibili/live/DanmakuStore';
import { ClaudeCodeInitializer } from '@/services/claudeCode';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import { RetrievalService } from '@/services/retrieval/RetrievalService';
import { initStaticServer } from '@/services/staticServer';
import type { TTSManager } from '@/services/tts/TTSManager';
import { VoiceReplyChannel } from '@/services/tts/VoiceReplyChannel';
import { logger, setMessageLogFilter } from '@/utils/logger';
import { registerConnectionClass } from './connection/ConnectionManager';
import { registerProviders } from './wiring';

// Decorator registries: command handlers, plugins and tool executors register themselves
// at import time, so the composition root imports their barrels. The managers that read
// those registries must not: a service module importing its own consumers closes an import
// cycle, and class-token injection in those consumers then fails with a TDZ error that
// depends on load order.
import '@/command/handlers';
import '@/plugins/plugins';
import '@/tools/executors';
// Avatar integration registers its own plugins via this barrel side-effect
// import — PluginManager stays unaware of integrations.
import '@/integrations/avatar/plugins';

export interface BootstrapResult {
  bot: Bot;
  claudeCodeService: ClaudeCodeService | null;
  clusterManager: ClusterManager | null;
  conversationComponents: ConversationComponents;
  eventRouter: EventRouter;
  retrievalService: RetrievalService;
  avatarService: AvatarService | null;
  bilibiliLiveBridge: BilibiliLiveBridge | null;
}

/**
 * Bootstrap the application: initialize all services, DI registrations, and plugins.
 *
 * Covers every initialization step that does NOT require live network I/O:
 *   Config → API client → Wiring → Prompt → Health/Retrieval → Static server →
 *   Claude Code init → Conversation system → Event system →
 *   Protocol adapter registration → Plugin load and enable → DI contract check
 */
export async function bootstrapApp(configPath?: string): Promise<BootstrapResult> {
  // ── Config & basic setup ──
  const bot = new Bot(configPath);
  const config = bot.getConfig();
  const container = getContainer();

  // ── Apply per-message log filter (must run before pipeline starts) ──
  const loggingConfig = config.getLoggingConfig();
  const mf = loggingConfig?.messageFilter;
  if (mf?.enabled) {
    setMessageLogFilter({
      groupIds: new Set((mf.groupIds ?? []).map(String)),
      userIds: new Set((mf.userIds ?? []).map(String)),
      allowLevels: new Set(mf.allowLevels ?? ['warn', 'error']),
    });
    logger.info(
      `[Bootstrap] Message log filter enabled — groups=[${[...(mf.groupIds ?? [])].join(',')}] users=[${[...(mf.userIds ?? [])].join(',')}]`,
    );
  }

  const apiConfig = config.getAPIConfig();
  const apiClient = new APIClient(apiConfig.strategy, apiConfig.preferredProtocol);

  // ── Wiring: a provider for every core service; each is built on first resolve ──
  registerProviders(config, apiClient);

  // ── Prompt system ──
  PromptInitializer.initialize(config);

  // ── Health + Retrieval ──
  const healthCheckManager = container.resolve(HealthCheckManager);
  const retrievalService = container.resolve(RetrievalService);
  const ragConfig = config.getRAGConfig();
  if (ragConfig?.enabled) {
    logger.info(
      `[Bootstrap] RAG enabled | ollama=${ragConfig.ollama?.url} model=${ragConfig.ollama?.model} qdrant=${ragConfig.qdrant?.url}`,
    );
  }

  // ── StaticServer (local HTTP + backends; must precede ConversationInitializer — ImageGenerationService needs it) ──
  // Optional: `lanRelay.*.disabledStaticBackends` omits specific backend modules (see createBackends registry).
  // `ticketsDir` is resolved once here and shared with the Agent Cluster below
  // so `ContextHub` (plan artifacts) and `ClusterTicketWriteback` point at
  // the same filesystem root as `TicketBackend` (which pulls via `config`).
  const ticketsDir = config.getTicketsDir();
  const staticServerConfig = config.getStaticServerConfig();
  if (staticServerConfig) {
    const disabledBackendIds = config.getDisabledStaticBackendIds();
    await initStaticServer(staticServerConfig, { disabledBackendIds, config });
  }

  // ── Claude Code init (sync, no connections) ──
  const claudeCodeService = ClaudeCodeInitializer.initialize(config);

  // ── Agent Cluster init (sync, no connections) ──
  let clusterManager: ClusterManager | null = null;
  const clusterRawConfig = config.getClusterConfig();
  const clusterConfig = parseClusterConfig(clusterRawConfig);

  // ── Conversation system (tools, hooks, commands, AI, DB, context, agenda) ──
  const conversationComponents = await ConversationInitializer.initialize(config);

  // ── Register core prompt producers (after PromptManager and PromptInjectionRegistry are ready) ──
  // PromptManager is registered by PromptInitializer above; PromptInjectionRegistry is registered
  // just above ConversationInitializer. These producers cover the entire main reply pipeline:
  //   baseline → base.system + persona-stable + optional per-provider patch (system msg #1)
  //   scene    → per-source scene template (system msg #2 front)
  //   tool     → llm.tool.instruct (system msg #2 back)
  // Volatile persona-runtime producer is registered later by PersonaInitializer (via startPersonaSubsystem).
  {
    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const registry = container.resolve(PromptInjectionRegistry);
    const wakeWords =
      (config.getPluginConfig('messageTrigger') as { wakeWords?: string[] } | undefined)?.wakeWords ?? [];
    registry.register(createBaselineProducer({ promptManager }));
    registry.register(createModelIdentityProducer({ promptManager }));
    registry.register(createProviderPatchProducer({ promptManager }));
    registry.register(createSceneProducer({ promptManager, wakeWords }));
    registry.register(createFaceUsageProducer({ promptManager }));
    registry.register(createToolInstructProducer({ promptManager }));
    logger.info(
      '[Bootstrap] Core prompt producers registered (baseline, model-identity, provider-patch, scene, face-usage, tool-instruct)',
    );
  }

  // ── Admin alerting: route uncaught process errors to the owner ──
  const adminAlertService = container.resolve(AdminAlertService);
  adminAlertService.installProcessBoundary();

  // ── Agent Cluster (after DB is ready) ──
  if (clusterConfig) {
    try {
      const { DatabaseManager } = await import('@/database/DatabaseManager');
      const { SQLiteAdapter } = await import('@/database/adapters/SQLiteAdapter');
      const dbManager = container.resolve<InstanceType<typeof DatabaseManager>>(DatabaseManager);
      const adapter = dbManager.getAdapter();
      if (!(adapter instanceof SQLiteAdapter)) {
        throw new Error('[Bootstrap] Agent Cluster requires SQLite database adapter');
      }
      const rawDb = adapter.getRawDb();
      if (!rawDb) {
        throw new Error('[Bootstrap] Agent Cluster requires SQLite — raw DB not available');
      }
      const projectRegistry =
        container.resolve<InstanceType<typeof import('@/services/claudeCode/ProjectRegistry').ProjectRegistry>>(
          ProjectRegistry,
        );
      clusterManager = new ClusterManager(clusterConfig, rawDb, projectRegistry, ticketsDir);
      container.registerInstance(DITokens.CLUSTER_MANAGER, clusterManager);

      await wireClusterEscalation(clusterManager, config);
      wireClusterTicketWriteback(clusterManager);

      clusterManager.setHealthAlertNotifier(async (failures) => {
        await adminAlertService.alert({
          scope: 'ClusterHealth',
          title: `${failures.length} worker template(s) unavailable`,
          detail: failures.map((f) => `✗ ${f.templateName}: ${f.reason ?? 'unknown'}`).join('\n'),
        });
      });

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

  // ── Load plugins (onInit for every plugin, onEnable for the ones enabled in config) ──
  // Plugin load throws an aggregate error if any plugin's onInit/onEnable failed —
  // that's the smoke-test signal for "DI wiring is broken at load time".
  await PluginInitializer.loadPlugins(config);

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

  // ── LLM voice channel (`speak` tool + its prompt default) ──
  container.resolve(VoiceReplyChannel).install();

  // ── Avatar system (sync init, no driver connections) ──
  // Config schema & defaults live in the avatar package; we just forward the
  // raw JSONC blob. `initialize()` is a no-op when the avatar section is
  // absent or `enabled: false`.
  let avatarService: AvatarService | null = null;
  try {
    avatarService = new AvatarService();
    await avatarService.initialize(config.getAvatarConfig(), container.resolve<TTSManager>(DITokens.TTS_MANAGER));
    if (avatarService.isEnabled()) {
      container.registerInstance(DITokens.AVATAR_SERVICE, avatarService);
      logger.info('[Bootstrap] Avatar service initialized');
    } else {
      avatarService = null;
    }
  } catch (err) {
    logger.warn('[Bootstrap] Avatar service failed to initialize (non-fatal):', err);
    avatarService = null;
  }

  // ── Mind subsystem lifecycle ──
  // PERSONA_SERVICE / PERSONA_MODULATION_PROVIDER are required (DITokens.ts);
  // PersonaInitializer always registers them, even when persona is disabled.
  // The "avatar may be absent" comment still applies — `avatarService` itself
  // is the gated piece, and `startPersonaSubsystem` accepts null.
  const personaService = container.resolve<PersonaService>(DITokens.PERSONA_SERVICE);
  const modulationProvider = container.resolve<PersonaModulationAdapter>(DITokens.PERSONA_MODULATION_PROVIDER);
  startPersonaSubsystem(personaService, modulationProvider, avatarService);

  // ── Livemode: private chat of livemode users feeds their danmaku buffer ──
  container.resolve(ProcessStageInterceptorRegistry).register(container.resolve(LivemodeInterceptor));

  // ── Bilibili live listener (optional) ──
  // Fully gated on `bilibili.live.enabled` — no side effects when absent.
  // The bridge is started later (alongside other network-I/O services) by
  // the caller, matching the existing `bot.start()` / `avatarService.start()`
  // pattern.
  let bilibiliLiveBridge: BilibiliLiveBridge | null = null;
  try {
    const liveCfg = config.getBilibiliLiveConfig();
    if (liveCfg) {
      const aliases = liveCfg.streamerAliases ?? [];
      const client = new BilibiliLiveClient({
        roomId: liveCfg.roomId,
        sessdata: liveCfg.sessdata,
        biliJct: liveCfg.biliJct,
        sendEnabled: liveCfg.send?.enabled ?? false,
      });
      const buffer = new DanmakuBuffer({
        flushIntervalMs: liveCfg.buffer?.flushIntervalMs,
        maxTextLen: liveCfg.buffer?.maxTextLen,
        streamerAliases: aliases,
      });
      const store = container.resolve(DanmakuStore);
      bilibiliLiveBridge = new BilibiliLiveBridge(client, buffer, store, container.resolve(MessagePipeline), {
        roomId: String(liveCfg.roomId),
        pipeToLive2D: liveCfg.pipeToLive2D !== false,
        streamerAliases: aliases,
      });
      container.registerInstance(DITokens.BILIBILI_LIVE_CLIENT, client);
      container.registerInstance(DITokens.BILIBILI_LIVE_BRIDGE, bilibiliLiveBridge);
      container.registerInstance(DITokens.BILIBILI_DANMAKU_STORE, store);
      logger.info(
        `[Bootstrap] Bilibili live bridge configured (room=${liveCfg.roomId}, pipeToLive2D=${liveCfg.pipeToLive2D !== false}, autoConnect=${liveCfg.autoConnect === true})`,
      );
    }
  } catch (err) {
    logger.warn('[Bootstrap] Bilibili live bridge init failed (non-fatal):', err);
    bilibiliLiveBridge = null;
  }

  // ── Final DI contract check ──
  // Runs LAST, after every initializer (TTS / Avatar / Livemode / Bilibili)
  // has had a chance to register its tokens. Throws on any missing
  // `required: true` token in `DITokens.ts` so smoke-test fails loud
  // instead of letting consumers null-deref later.
  getContainer().verifyRequiredTokens();

  logger.info('[Bootstrap] All initialization stages completed');

  return {
    bot,
    claudeCodeService,
    clusterManager,
    conversationComponents,
    eventRouter,
    retrievalService,
    avatarService,
    bilibiliLiveBridge,
  };
}

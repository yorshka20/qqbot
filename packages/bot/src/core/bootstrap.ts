// Shared application bootstrap — single source of truth for initialization order.
//
// Both src/index.ts (production) and src/cli/smoke-test.ts (CI validation) call
// this function so that the initialization sequence can never drift between them.
//
// Only steps that require live network I/O are left to callers:
//   bot.start(), MCPInitializer.connectServers(), ClaudeCodeInitializer.start(),
//   and process signal handlers.

import { AvatarService } from '@qqbot/avatar';
import { PromptInitializer } from '@/ai/prompt/PromptInitializer';
import { PromptInjectionRegistry } from '@/conversation/promptInjection/PromptInjectionRegistry';
import { APIClient } from '@/api/APIClient';
import { ClusterManager, parseClusterConfig, wireClusterEscalation, wireClusterTicketWriteback } from '@/cluster';
import type { ConversationComponents } from '@/conversation/ConversationInitializer';
import { ConversationInitializer } from '@/conversation/ConversationInitializer';
import type { ProcessStageInterceptorRegistry } from '@/conversation/ProcessStageInterceptor';
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
import { type MindModulationAdapter, type MindService, startMindSubsystem } from '@/mind';
import { PluginInitializer } from '@/plugins/PluginInitializer';
import { DiscordConnection } from '@/protocol/discord/DiscordConnection';
import { ProtocolAdapterInitializer } from '@/protocol/ProtocolAdapterInitializer';
import type { MessagePipeline } from '@/conversation/MessagePipeline';
import { makeSyntheticEvent } from '@/conversation/synthetic';
import { BilibiliLiveBridge } from '@/services/bilibili/live/BilibiliLiveBridge';
import { BilibiliLiveClient } from '@/services/bilibili/live/BilibiliLiveClient';
import { DanmakuBuffer } from '@/services/bilibili/live/DanmakuBuffer';
import { DanmakuStore } from '@/services/bilibili/live/DanmakuStore';
import { ClaudeCodeInitializer } from '@/services/claudeCode';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import { AvatarIdleTrigger } from '@/integrations/avatar/AvatarIdleTrigger';
import { AvatarMemoryExtractionCoordinator } from '@/integrations/avatar/AvatarMemoryExtractionCoordinator';
import { AvatarSessionService } from '@/integrations/avatar/AvatarSessionService';
import { LivemodeInterceptor } from '@/integrations/avatar/LivemodeInterceptor';
import { LivemodeState } from '@/integrations/avatar/LivemodeState';
import type { MCPSystem } from '@/services/mcp/MCPInitializer';
import { MCPInitializer } from '@/services/mcp/MCPInitializer';
import { RetrievalService } from '@/services/retrieval';
import { initStaticServer } from '@/services/staticServer';
import { FishAudioProvider } from '@/services/tts/providers/FishAudioProvider';
import { SovitsProvider } from '@/services/tts/providers/SovitsProvider';
import { TTSManager } from '@/services/tts/TTSManager';
import type { TTSProvider } from '@/services/tts/TTSProvider';
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
  avatarService: AvatarService | null;
  bilibiliLiveBridge: BilibiliLiveBridge | null;
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
  // `ticketsDir` is resolved once here and shared with the Agent Cluster below
  // so `TicketBackend`, `ContextHub` (plan artifacts) and `ClusterTicketWriteback`
  // all point at the same filesystem root.
  const ticketsDir = config.getTicketsDir();
  const staticServerConfig = config.getStaticServerConfig();
  if (staticServerConfig) {
    const disabledBackendIds = config.getDisabledStaticBackendIds();
    await initStaticServer(staticServerConfig, { disabledBackendIds, ticketsDir });
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

  // ── PromptInjectionRegistry (before ConversationInitializer so PromptAssemblyStage can resolve it) ──
  container.registerSingleton(DITokens.PROMPT_INJECTION_REGISTRY, PromptInjectionRegistry);

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
      clusterManager = new ClusterManager(clusterConfig, rawDb, projectRegistry, ticketsDir);
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

  // ── TTS providers / registry ──
  // Build the TTSManager from `tts.providers[]`. If the user still has the
  // legacy single-provider shape (top-level `apiKey`/`model`), synthesize a
  // one-element providers array inline so existing configs keep working
  // without a config migration pass. The resulting manager is registered in
  // DI so both TTSCommandHandler (QQ voice path) and AvatarService (renderer
  // speech path) consume the same provider set.
  const ttsManager = new TTSManager();
  try {
    const rawTTS = config.getTTSConfig() as Record<string, unknown> | undefined;
    const providerEntries = collectTTSProviderEntries(rawTTS);
    for (const entry of providerEntries) {
      const provider = instantiateTTSProvider(entry);
      if (provider) {
        ttsManager.register(provider);
      } else {
        logger.warn(`[Bootstrap] Unknown TTS provider type: ${String(entry.type)} (skipped)`);
      }
    }
    const desiredDefault = typeof rawTTS?.defaultProvider === 'string' ? rawTTS.defaultProvider : null;
    if (desiredDefault) {
      try {
        ttsManager.setDefault(desiredDefault);
      } catch (err) {
        logger.warn(
          `[Bootstrap] tts.defaultProvider="${desiredDefault}" is not a registered provider; falling back to first registered`,
          err,
        );
      }
    }
    ttsManager.attachHealthManager(healthCheckManager);
    container.registerInstance(DITokens.TTS_MANAGER, ttsManager);
    const summary = ttsManager.listAll().map((p) => `${p.name}${p.isAvailable() ? '' : ' (unavailable)'}`);
    if (summary.length > 0) {
      logger.info(`[Bootstrap] TTS providers registered: ${summary.join(', ')}`);
    } else {
      logger.debug('[Bootstrap] No TTS providers configured');
    }

    // Fire-and-forget warmup for providers that support it (Sovits mainly —
    // forces model weights + reference audio into memory so the first real
    // user utterance doesn't pay cold-start latency).
    for (const provider of ttsManager.listAll()) {
      if (typeof provider.warmup === 'function' && provider.isAvailable()) {
        const started = Date.now();
        provider
          .warmup()
          .then(() => {
            logger.info(`[Bootstrap] TTS warmup ok — provider="${provider.name}" took=${Date.now() - started}ms`);
          })
          .catch((err) => {
            logger.debug(
              `[Bootstrap] TTS warmup failed (non-fatal) — provider="${provider.name}" err=${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    }
  } catch (err) {
    logger.warn('[Bootstrap] TTS provider registry init failed (non-fatal):', err);
  }

  // ── Avatar system (sync init, no driver connections) ──
  // Config schema & defaults live in the avatar package; we just forward the
  // raw JSONC blob. `initialize()` is a no-op when the avatar section is
  // absent or `enabled: false`.
  let avatarService: AvatarService | null = null;
  try {
    avatarService = new AvatarService();
    await avatarService.initialize(config.getAvatarConfig(), ttsManager);
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
  // All per-service wiring (modulation provider, state source, pose
  // provider, wander scheduler) is encapsulated in `startMindSubsystem`
  // so bootstrap stays agnostic. Safe to call even when mind or avatar
  // is absent.
  try {
    if (container.isRegistered(DITokens.MIND_SERVICE)) {
      const mindService = container.resolve<MindService>(DITokens.MIND_SERVICE);
      const modulationProvider = container.resolve<MindModulationAdapter>(DITokens.MIND_MODULATION_PROVIDER);
      startMindSubsystem(mindService, modulationProvider, avatarService);
    }
  } catch (err) {
    logger.warn('[Bootstrap] Mind subsystem wiring failed (non-fatal):', err);
  }

  // ── AvatarSessionService (rolling thread history for avatar runs) ──
  // Avatar session service: rolling thread history for avatar runs.
  const avatarSessionService = container.resolve(AvatarSessionService);
  container.registerInstance(DITokens.AVATAR_SESSION_SERVICE, avatarSessionService);

  // ── AvatarMemoryExtractionCoordinator (write side of <memory_context>) ──
  // Resolves MemoryExtractService lazily, so if it isn't registered yet
  // (edge cases / test harnesses) the coordinator degrades to a no-op
  // instead of failing construction. Ordering against the MemoryExtract
  // registration therefore doesn't matter.
  const avatarMemoryExtractionCoordinator = container.resolve(AvatarMemoryExtractionCoordinator);
  container.registerInstance(DITokens.AVATAR_MEMORY_EXTRACTION_COORDINATOR, avatarMemoryExtractionCoordinator);

  // ── LivemodeState (per-user mock-livestream buffers) ──
  // Registered here so both the /livemode command and the PROCESS-stage
  // interceptor can resolve the same singleton. Its flush handler is wired
  // below (avoids a construction-order cycle).
  const livemodeState = container.resolve(LivemodeState);
  container.registerInstance(DITokens.LIVEMODE_STATE, livemodeState);

  // ── Livemode wiring ──
  // Resolve idle trigger before wiring the flush handler so the handler can
  // call `markActivity()` to reset the per-user idle clock on every flush.
  const messagePipeline = container.resolve<MessagePipeline>(DITokens.MESSAGE_PIPELINE);
  const avatarIdleTrigger = container.resolve(AvatarIdleTrigger);
  livemodeState.setFlushHandler((userId, payload) => {
    avatarIdleTrigger.markActivity(userId);
    const event = makeSyntheticEvent({
      source: 'idle-trigger',
      userId: String(userId),
      groupId: null,
      text: payload.summaryText,
      messageType: 'private',
      protocol: 'milky',
    });
    void messagePipeline.process(
      event,
      {
        message: event,
        sessionId: `idle-${userId}`,
        sessionType: 'user',
        botSelfId: '',
        source: 'idle-trigger',
      },
      'idle-trigger',
    );
  });
  avatarIdleTrigger.start();
  try {
    const interceptorRegistry = container.resolve<ProcessStageInterceptorRegistry>(
      DITokens.PROCESS_STAGE_INTERCEPTOR_REGISTRY,
    );
    interceptorRegistry.register(new LivemodeInterceptor(livemodeState));
    logger.info('[Bootstrap] Livemode interceptor + idle trigger registered');
  } catch (err) {
    logger.warn('[Bootstrap] Livemode interceptor registration failed (non-fatal):', err);
  }

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
      bilibiliLiveBridge = new BilibiliLiveBridge(client, buffer, store, messagePipeline, {
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

  logger.info('[Bootstrap] All initialization stages completed');

  return {
    bot,
    mcpSystem,
    claudeCodeService,
    clusterManager,
    conversationComponents,
    eventRouter,
    retrievalService,
    avatarService,
    bilibiliLiveBridge,
  };
}

interface TTSProviderEntry {
  type: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Gather provider entries from the raw `tts` config blob.
 *
 * - If `tts.providers` is an array, return it as-is.
 * - Otherwise fall back to the legacy single-provider shape: top-level
 *   `apiKey` + optional `model`/`format`/`voiceMap`/`defaultVoice`/`referenceId`
 *   are synthesized into a single `{ type: 'fish-audio', name: 'fish-audio', … }`
 *   entry. This lets existing configs keep working without migration.
 * - Empty / missing `tts` returns `[]`.
 */
function collectTTSProviderEntries(raw: Record<string, unknown> | undefined): TTSProviderEntry[] {
  if (!raw) return [];
  if (Array.isArray(raw.providers)) {
    return raw.providers.filter((p): p is TTSProviderEntry => typeof p === 'object' && p !== null);
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey.length > 0) {
    return [
      {
        type: 'fish-audio',
        name: 'fish-audio',
        apiKey: raw.apiKey,
        model: raw.model,
        format: raw.format,
        voiceMap: raw.voiceMap,
        defaultVoice: raw.defaultVoice ?? raw.referenceId,
      },
    ];
  }
  return [];
}

/**
 * Instantiate a TTSProvider from a config entry. `type` discriminates which
 * concrete provider class to construct. Unknown types return null (caller
 * logs and skips so one bad entry doesn't block the rest).
 */
function instantiateTTSProvider(entry: TTSProviderEntry): TTSProvider | null {
  const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined;
  switch (entry.type) {
    case 'fish-audio':
      return new FishAudioProvider({
        name,
        apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
        voiceMap:
          entry.voiceMap && typeof entry.voiceMap === 'object' && !Array.isArray(entry.voiceMap)
            ? (entry.voiceMap as Record<string, string>)
            : {},
        defaultVoice: typeof entry.defaultVoice === 'string' ? entry.defaultVoice : '',
        model: typeof entry.model === 'string' ? entry.model : undefined,
        format: entry.format === 'mp3' || entry.format === 'wav' ? (entry.format as 'mp3' | 'wav') : undefined,
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
      });
    case 'sovits':
      return new SovitsProvider({
        name,
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : '',
        bodyTemplate:
          entry.bodyTemplate && typeof entry.bodyTemplate === 'object' && !Array.isArray(entry.bodyTemplate)
            ? (entry.bodyTemplate as Record<string, unknown>)
            : {},
        method: entry.method === 'GET' || entry.method === 'POST' ? entry.method : undefined,
        headers:
          entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
            ? (entry.headers as Record<string, string>)
            : undefined,
        defaultVoice: typeof entry.defaultVoice === 'string' ? entry.defaultVoice : undefined,
        pcmSampleRate:
          typeof entry.pcmSampleRate === 'number' && entry.pcmSampleRate > 0 ? entry.pcmSampleRate : undefined,
      });
    default:
      return null;
  }
}

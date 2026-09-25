// Application lifecycle shared by the bot process, the smoke test and the debug CLI.
//
// startApp() runs bootstrapApp() (wiring and every startup step that needs no external
// connection), then — only with `connect` — opens the live connections, and returns the
// one shutdown sequence. Callers differ only in that flag and in what they do around it,
// so the module graph, the initialization order and the shutdown path are the same code
// in production and in the smoke test.

import type { Database } from 'bun:sqlite';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { initLanRelay } from '@/lan';
import type { PluginManager } from '@/plugins/PluginManager';
import { ClaudeCodeInitializer } from '@/services/claudeCode';
import { killAllMcpChildren } from '@/services/retrieval/searxng/mcp/childReaper';
import { stopStaticServer } from '@/services/staticServer';
import type { ResourceCleanupService } from '@/services/video';
import { logger } from '@/utils/logger';
import { type BootstrapResult, bootstrapApp } from './bootstrap';
import { getContainer } from './DIContainer';
import { DITokens } from './DITokens';

export interface StartAppOptions {
  /**
   * Open protocol sockets and start every network-facing service and plugin
   * (`onStart`). Without it the app is fully built but talks to nothing.
   */
  connect: boolean;
}

export interface App extends BootstrapResult {
  shutdown(): Promise<void>;
}

export async function startApp(configPath: string | undefined, options: StartAppOptions): Promise<App> {
  const bootstrap = await bootstrapApp(configPath);
  const { conversationComponents, eventRouter, retrievalService } = bootstrap;

  const container = getContainer();
  const pluginManager = container.resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
  const resourceCleanupService = container.resolve<ResourceCleanupService>(DITokens.RESOURCE_CLEANUP_SERVICE);

  const disconnect = options.connect ? await connect(bootstrap, pluginManager) : null;

  const shutdown = async (): Promise<void> => {
    // Kill MCP child subtrees FIRST: every later step can throw or hang,
    // and this must complete before PM2 escalates to SIGKILL, otherwise
    // the bunx/node subtree is orphaned to init.
    await killAllMcpChildren();
    await pluginManager.stopAll();
    stopStaticServer();
    await resourceCleanupService.cleanupAll();
    await disconnect?.();
    eventRouter.destroy();
    await retrievalService.disconnectSearchTransports();
    await conversationComponents.databaseManager.close();
  };

  return { ...bootstrap, shutdown };
}

/** Open every live connection; returns the function that closes them again. */
async function connect(bootstrap: BootstrapResult, pluginManager: PluginManager): Promise<() => Promise<void>> {
  const {
    bot,
    claudeCodeService,
    clusterManager,
    conversationComponents,
    eventRouter,
    retrievalService,
    avatarService,
    bilibiliLiveBridge,
  } = bootstrap;
  const config = bot.getConfig();
  const messageAPI = getContainer().resolve<MessageAPI>(DITokens.MESSAGE_API);

  // Start bot (opens WebSocket connections)
  await bot.start();

  // Start avatar system (connects to VTubeStudio driver, non-fatal)
  if (avatarService) {
    try {
      await avatarService.start();
    } catch (error) {
      logger.warn('[App] Avatar service failed to start (non-fatal):', error);
    }
  }

  // Start bilibili live bridge only when `bilibili.live.autoConnect=true`.
  // Default is false — the operator is expected to trigger `/live2d
  // connect` after the stream goes live to avoid hammering bilibili's
  // getDanmuInfo with retries while the room is offline / risk-controlled.
  const bilibiliLiveCfg = config.getBilibiliLiveConfig();
  if (bilibiliLiveBridge && bilibiliLiveCfg?.autoConnect === true) {
    try {
      await bilibiliLiveBridge.start();
    } catch (error) {
      logger.warn('[App] Bilibili live bridge failed to start (non-fatal):', error);
    }
  } else if (bilibiliLiveBridge) {
    logger.info('[App] Bilibili live bridge is configured but autoConnect=false; use /live2d connect to start it');
  }

  // Pull rawDb (sqlite only) so the host can persist client internal_report
  // envelopes into `lan_internal_reports`. Non-sqlite deployments pass null
  // and reports just log to console.
  let rawDb: Database | null = null;
  try {
    const adapter = conversationComponents.databaseManager.getAdapter() as unknown as {
      getRawDb?: () => Database | null;
    };
    // Duck-type: SQLiteAdapter exposes getRawDb(); other adapters do not.
    if (typeof adapter.getRawDb === 'function') {
      rawDb = adapter.getRawDb();
    }
  } catch {
    rawDb = null;
  }
  const lanRelayHandle = await initLanRelay({ config, eventRouter, messageAPI, rawDb });

  // Bring up search transports that need I/O (SearXNG MCP stdio child)
  await retrievalService.connectSearchTransports();

  // Start Claude Code service (non-fatal if port is in use)
  if (claudeCodeService) {
    try {
      await ClaudeCodeInitializer.start(claudeCodeService, messageAPI);
      const protocols = config.getEnabledProtocols().map((p) => p.name);
      ClaudeCodeInitializer.updateBotInfo(claudeCodeService, config.getConfig().bot.selfId, protocols);
    } catch (error) {
      logger.warn('[App] Claude Code service failed to start (non-fatal):', error);
    }
  }

  // Start Agent Cluster (non-fatal)
  if (clusterManager) {
    try {
      await clusterManager.start();
    } catch (error) {
      logger.warn('[App] Agent Cluster failed to start (non-fatal):', error);
    }
  }

  // Plugin timers, servers and startup jobs run only once the bot is connected.
  await pluginManager.startAll();

  return async () => {
    if (bilibiliLiveBridge) {
      await bilibiliLiveBridge.stop();
    }
    if (avatarService) {
      await avatarService.stop();
    }
    if (clusterManager) {
      await clusterManager.stop();
    }
    await lanRelayHandle.stop();
    await ClaudeCodeInitializer.stop(claudeCodeService);
    await bot.stop();
  };
}

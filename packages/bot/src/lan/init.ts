// LAN relay entry point — instantiates either the host or the client based
// on config and stores it in the module-level runtime slot.
//
// Called from src/index.ts AFTER bootstrapApp() and bot.start() so that the
// EventRouter and MessageAPI are fully wired before the relay starts emitting
// events or accepting incoming connections. Returns a handle whose stop()
// method is invoked from the shutdown signal handler.

import type { Database } from 'bun:sqlite';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import type { EventRouter } from '@/events/EventRouter';
import { logger } from '@/utils/logger';
import { LanRelayClient } from './client/LanRelayClient';
import { LanRelayHost } from './host/LanRelayHost';
import { setLanRelayRuntime } from './types/runtime';

/** Lifecycle handle returned by initLanRelay; main() calls .stop() on shutdown. */
export interface LanRelayHandle {
  stop: () => Promise<void>;
}

export async function initLanRelay(opts: {
  config: Config;
  eventRouter: EventRouter;
  messageAPI: MessageAPI;
  /** Optional sqlite raw db (host only — for internal_report persistence). */
  rawDb?: Database | null;
}): Promise<LanRelayHandle> {
  const lr = opts.config.getLanRelayConfig();
  if (!lr?.enabled) {
    setLanRelayRuntime(null);
    return {
      stop: async () => {},
    };
  }

  if (lr.instanceRole === 'host') {
    const host = new LanRelayHost(opts.config, opts.eventRouter, opts.messageAPI, opts.rawDb ?? null);
    await host.start();
    setLanRelayRuntime(host);
    logger.info('[LanRelay] Host mode active');
    return {
      stop: () => host.stop(),
    };
  }

  // Client mode: connect to a remote host. start() is intentionally
  // non-blocking on initial-connect failure (see LanRelayClient.start) so the
  // process boots even if the host is briefly down.
  const client = new LanRelayClient(opts.config, opts.eventRouter);
  await client.start();
  setLanRelayRuntime(client);
  logger.info('[LanRelay] Client mode active');
  return {
    stop: () => client.stop(),
  };
}

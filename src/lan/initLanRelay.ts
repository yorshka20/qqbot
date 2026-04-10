// LAN relay entry point — instantiates either the host or the client based
// on config and stores it in the module-level runtime slot.
//
// Called from src/index.ts AFTER bootstrapApp() and bot.start() so that the
// EventRouter and MessageAPI are fully wired before the relay starts emitting
// events or accepting incoming connections. Returns a handle whose stop()
// method is invoked from the shutdown signal handler.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import type { EventRouter } from '@/events/EventRouter';
import { logger } from '@/utils/logger';
import { LanRelayClient } from './LanRelayClient';
import { LanRelayHost } from './LanRelayHost';
import { setLanRelayRuntime } from './runtime';

/** Lifecycle handle returned by initLanRelay; main() calls .stop() on shutdown. */
export interface LanRelayHandle {
  stop: () => Promise<void>;
}

export async function initLanRelay(opts: {
  config: Config;
  eventRouter: EventRouter;
  messageAPI: MessageAPI;
}): Promise<LanRelayHandle> {
  const lr = opts.config.getLanRelayConfig();
  // Disabled (or no lanRelay block at all) → ensure the runtime slot is empty
  // so getLanRelayRuntime() returns null and SendSystem stays on its native
  // MessageAPI path. The handle's stop() is a no-op in this branch.
  if (!lr?.enabled) {
    setLanRelayRuntime(null);
    return {
      stop: async () => {},
    };
  }

  if (lr.instanceRole === 'host') {
    // Host mode: spin up a Bun.serve WebSocket server. Awaiting start() lets
    // a port-bind error fail loudly during boot rather than later.
    const host = new LanRelayHost(opts.config, opts.eventRouter, opts.messageAPI);
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

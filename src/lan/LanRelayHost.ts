// LAN relay WebSocket host.
//
// Runs on instances configured with `lanRelay.instanceRole === 'host'`.
// Responsibilities:
//   1. Listen on a LAN port for LanRelayClient connections (token-authenticated).
//   2. Optionally fan out IM-side inbound messages to all connected clients
//      (`relayInboundFromIm`), so that "headless" client instances can run
//      the same message pipeline against the real IM events.
//   3. Execute `relay_action` envelopes from clients by calling MessageAPI
//      against the live IM connection on this host, then ack the result.
//
// Independent of Agent Cluster (ContextHub) — runs its own Bun.serve so the
// LAN relay can be used standalone without enabling cluster features.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { SendMessageResult } from '@/api/types';
import type { Config } from '@/core/config';
import type { LanRelayConfig } from '@/core/config/types/lanRelay';
import type { EventRouter } from '@/events/EventRouter';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import type { ILanRelayRuntime } from './runtime';
import type { LanRelayActionPayload, LanRelayEnvelope, LanRelayHelloPayload, LanRelayInboundPayload } from './types';
import { LAN_RELAY_WS_PATH } from './types';

/** Per-connection state attached to each upgraded WebSocket. */
type ClientData = {
  /** True after the HTTP upgrade passed the token check. */
  authenticated: boolean;
  /** Optional client identifier from the hello envelope, used in logs. */
  clientId?: string;
};

export class LanRelayHost implements ILanRelayRuntime {
  /** Underlying Bun HTTP/WebSocket server; null until start() and after stop(). */
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** All currently connected (authenticated) client sockets — used for fan-out. */
  private readonly clients = new Set<import('bun').ServerWebSocket<ClientData>>();
  private readonly cfg: LanRelayConfig;
  private readonly token: string;
  private readonly messageAPI: MessageAPI;
  /** Disposer for the EventRouter listener installed when relayInboundFromIm is enabled. */
  private unsubscribeInbound: (() => void) | null = null;

  constructor(
    config: Config,
    private readonly eventRouter: EventRouter,
    messageAPI: MessageAPI,
  ) {
    const lr = config.getLanRelayConfig();
    if (!lr) {
      throw new Error('LanRelayHost: lanRelay config missing');
    }
    this.cfg = lr;
    // Token is also enforced by Config.validateLanRelayConfig — re-check so the
    // class is safe to construct independently.
    if (!lr.token) {
      throw new Error('LanRelayHost: token is required (validated by Config)');
    }
    this.token = lr.token;
    this.messageAPI = messageAPI;
  }

  isClientMode(): boolean {
    return false;
  }

  isHostMode(): boolean {
    return true;
  }

  /**
   * Reject relay calls on the host side: outbound messages on the host go
   * directly through MessageAPI, never through this runtime helper. Only the
   * client variant of ILanRelayRuntime implements this meaningfully.
   */
  relayOutboundSend(): Promise<SendMessageResult> {
    return Promise.reject(new Error('LanRelayHost: relayOutboundSend is only valid on client'));
  }

  async start(): Promise<void> {
    const port = this.cfg.listenPort;
    const hostname = this.cfg.listenHost ?? '0.0.0.0';
    if (port == null || Number.isNaN(Number(port))) {
      throw new Error('lanRelay.listenPort is required for host mode');
    }

    // Capture into locals so the inline websocket handlers below don't need
    // `this` (Bun's handler signatures bind their own `this`).
    const token = this.token;
    const messageAPI = this.messageAPI;
    const clients = this.clients;

    this.server = Bun.serve<ClientData>({
      port,
      hostname,
      // The fetch handler doubles as the WebSocket upgrade gate: only requests
      // hitting LAN_RELAY_WS_PATH with a valid token are allowed to upgrade.
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname !== LAN_RELAY_WS_PATH) {
          return new Response('Not Found', { status: 404 });
        }
        // Token may be passed as a query param (browser-friendly) or as a
        // bearer header (CLI / curl tests).
        const qToken =
          url.searchParams.get('token') ?? req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (qToken !== token) {
          return new Response('Unauthorized', { status: 401 });
        }
        const upgraded = server.upgrade(req, { data: { authenticated: true } });
        if (upgraded) {
          // When upgrade returns true, Bun has taken over the response — return
          // undefined so the fetch handler doesn't also send one.
          return undefined;
        }
        return new Response('Upgrade failed', { status: 500 });
      },
      websocket: {
        open(ws) {
          logger.info('[LanRelayHost] Client connected');
          clients.add(ws);
        },
        message(ws, message) {
          // Delegate to the free function so the per-message logic is testable
          // without needing a Bun.serve instance.
          void handleHostClientMessage(ws, message, messageAPI);
        },
        close(ws) {
          clients.delete(ws);
          logger.info('[LanRelayHost] Client disconnected', ws.data?.clientId ?? '');
        },
      },
    });

    logger.info(`[LanRelayHost] Listening on ws://${hostname}:${port}${LAN_RELAY_WS_PATH}`);

    // Optional inbound fan-out: when enabled, every NormalizedMessageEvent
    // routed by EventRouter (i.e. messages received over IM on this host) is
    // forwarded to every connected LAN client as an `inbound_message` envelope.
    // The clients then re-inject the event into their own EventRouter so they
    // can process it as if it had been received locally.
    if (this.cfg.relayInboundFromIm) {
      const handler = (event: NormalizedMessageEvent) => {
        const env: LanRelayEnvelope<LanRelayInboundPayload> = {
          v: 1,
          type: 'inbound_message',
          payload: { event },
        };
        const raw = JSON.stringify(env);
        for (const c of clients) {
          try {
            c.send(raw);
          } catch {
            // Best-effort fan-out: drop dead sockets and continue with the rest.
            clients.delete(c);
          }
        }
      };
      this.eventRouter.on('message', handler);
      this.unsubscribeInbound = () => {
        this.eventRouter.off('message', handler);
      };
    }
  }

  async stop(): Promise<void> {
    // Detach the EventRouter listener first so no more fan-out runs while we
    // are tearing the server down.
    if (this.unsubscribeInbound) {
      this.unsubscribeInbound();
      this.unsubscribeInbound = null;
    }
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.clients.clear();
    logger.info('[LanRelayHost] Stopped');
  }
}

/**
 * Per-message dispatcher for an authenticated client socket. Handles three
 * envelope types from the client:
 *   - `ping`         : reply with `pong` (basic liveness check).
 *   - `hello`        : record clientId for log identification, ack with hello_ack.
 *   - `relay_action` : execute the contained reply via MessageAPI on this
 *                      host's IM connection, then send back `relay_ack` carrying
 *                      either the SendMessageResult or an error message.
 *
 * Errors are caught and reported back via `relay_ack` so the client side can
 * surface them through its pending-promise machinery instead of timing out.
 */
async function handleHostClientMessage(
  ws: import('bun').ServerWebSocket<ClientData>,
  message: string | Buffer,
  messageAPI: MessageAPI,
): Promise<void> {
  // Bun may pass binary frames as Buffer; envelopes are always JSON text.
  const text = typeof message === 'string' ? message : message.toString();
  let parsed: LanRelayEnvelope;
  try {
    parsed = JSON.parse(text) as LanRelayEnvelope;
  } catch {
    logger.warn('[LanRelayHost] Invalid JSON from client');
    return;
  }

  // Reject envelopes from a future protocol version or with no type tag.
  if (parsed.v !== 1 || !parsed.type) {
    return;
  }

  if (parsed.type === 'ping') {
    ws.send(JSON.stringify({ v: 1, type: 'pong', id: parsed.id } satisfies LanRelayEnvelope));
    return;
  }

  if (parsed.type === 'hello') {
    const p = parsed.payload as LanRelayHelloPayload | undefined;
    if (p?.clientId && ws.data) {
      // Stash on per-socket data so close-time logs can identify which client left.
      ws.data.clientId = p.clientId;
    }
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'hello_ack',
        id: parsed.id,
      } satisfies LanRelayEnvelope),
    );
    return;
  }

  if (parsed.type === 'relay_action') {
    // The id is required to correlate the future relay_ack with the client's
    // pending promise; default to an empty string so the client can still
    // recognize an error reply if it neglected to set one.
    const id = parsed.id ?? '';
    const payload = parsed.payload as LanRelayActionPayload | undefined;
    if (!payload?.originalEvent || !payload.replySegments) {
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'relay_error',
          id,
          payload: { ok: false, error: 'invalid relay_action payload' },
        } satisfies LanRelayEnvelope),
      );
      return;
    }

    try {
      if (payload.useForward) {
        // Forward messages need the bot's own QQ user id (the "node" sender).
        // The client must have resolved this from its own config.bot.selfId
        // and passed it through; we re-validate here defensively.
        const botSelfId = payload.botSelfIdForForward;
        if (botSelfId == null || Number.isNaN(Number(botSelfId)) || botSelfId <= 0) {
          throw new Error('Forward relay requires botSelfIdForForward');
        }
        const result = await messageAPI.sendForwardFromContext(
          [{ segments: payload.replySegments, senderName: 'Bot' }],
          payload.originalEvent,
          60000,
          { botUserId: botSelfId },
        );
        ws.send(
          JSON.stringify({
            v: 1,
            type: 'relay_ack',
            id,
            payload: { ok: true, result },
          } satisfies LanRelayEnvelope),
        );
      } else {
        // Plain (non-forward) reply: send the segments through the host's
        // MessageAPI which will dispatch via the appropriate IM adapter.
        const result = await messageAPI.sendFromContext(payload.replySegments, payload.originalEvent, 60000);
        ws.send(
          JSON.stringify({
            v: 1,
            type: 'relay_ack',
            id,
            payload: { ok: true, result },
          } satisfies LanRelayEnvelope),
        );
      }
    } catch (err) {
      // Report the error back to the client as a normal relay_ack with ok=false
      // so its pending-promise resolver fires immediately rather than waiting
      // for the RELAY_TIMEOUT_MS deadline.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[LanRelayHost] relay_action failed:', err);
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'relay_ack',
          id,
          payload: { ok: false, error: msg },
        } satisfies LanRelayEnvelope),
      );
    }
  }
}

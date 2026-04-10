// LAN relay WebSocket client.
//
// Runs on instances configured with `lanRelay.instanceRole === 'client'`.
// Responsibilities:
//   1. Connect to a remote LanRelayHost over WebSocket (with auto-reconnect).
//   2. Receive `inbound_message` envelopes from the host and inject them into
//      the local EventRouter so the rest of the message pipeline runs as if
//      the IM event arrived locally.
//   3. Forward outbound replies to the host as `relay_action` envelopes,
//      because a client instance never opens an IM (QQ/Discord) connection
//      itself — only the host machine has the live IM session.

import { randomUUID } from 'node:crypto';
import type { SendMessageResult } from '@/api/types';
import type { Config } from '@/core/config';
import type { LanRelayConfig } from '@/core/config/types/lanRelay';
import type { EventRouter } from '@/events/EventRouter';
import { logger } from '@/utils/logger';
import type { ILanRelayRuntime, LanRelayOutboundParams } from './runtime';
import type { LanRelayActionPayload, LanRelayEnvelope, LanRelayHelloPayload, LanRelayInboundPayload } from './types';
import { LAN_RELAY_WS_PATH } from './types';

/** Max time to wait for a `relay_ack` from the host before failing the send. */
const RELAY_TIMEOUT_MS = 120_000;
/** Initial reconnect delay; the actual delay grows exponentially up to RECONNECT_MAX_MS. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

/** In-flight outbound relay request awaiting an ack from the host, keyed by envelope id. */
type Pending = {
  resolve: (v: SendMessageResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LanRelayClient implements ILanRelayRuntime {
  private readonly cfg: LanRelayConfig;
  /** Live WebSocket; null while disconnected or between reconnect attempts. */
  private ws: WebSocket | null = null;
  /** Outbound relay calls waiting for the host to ack. */
  private readonly pending = new Map<string, Pending>();
  /** Pending reconnect timer; null when no reconnect is currently scheduled. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of consecutive failed connect attempts; drives the exponential backoff. */
  private reconnectAttempt = 0;
  /** Set on stop() to inhibit reconnect loops after shutdown is requested. */
  private stopped = false;
  /** Final ws:// URL with token query param baked in (built once in constructor). */
  private readonly connectUrlResolved: string;

  constructor(
    config: Config,
    private readonly eventRouter: EventRouter,
  ) {
    const lr = config.getLanRelayConfig();
    if (!lr) {
      throw new Error('LanRelayClient: lanRelay config missing');
    }
    this.cfg = lr;
    // Config validation also checks these — re-check here so the constructor
    // is safe to use independently of Config.validateLanRelayConfig().
    const url = lr.connectUrl;
    const tok = lr.token;
    if (!url || !tok) {
      throw new Error('LanRelayClient: connectUrl and token are required (validated by Config)');
    }
    this.connectUrlResolved = buildClientWsUrl(url, tok);
  }

  isClientMode(): boolean {
    return true;
  }

  isHostMode(): boolean {
    return false;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Fire-and-forget the initial attempt: if the host is briefly down at boot,
    // we still want the client process to come up and reconnect in the background
    // (see scheduleReconnect on close). Outbound relay calls fail fast until the
    // socket is open again.
    this.connectOnce().catch((err) => {
      logger.warn('[LanRelayClient] Initial connect failed, will retry in background:', err);
      // Normally the close event listener already called scheduleReconnect, but
      // if the WebSocket constructor itself threw synchronously no listeners
      // were attached — schedule explicitly here to cover that path.
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Open a single WebSocket and resolve when the `open` event fires.
   * Rejects on the first `error` or `close` event before open.
   * The `close` listener also calls scheduleReconnect() so the reconnect
   * loop is self-sustaining once a connection has ever been attempted.
   */
  private async connectOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }

    return new Promise((resolve, reject) => {
      // Ensures resolve/reject is only invoked once even if multiple WS events fire.
      let settled = false;
      try {
        const socket = new WebSocket(this.connectUrlResolved);
        this.ws = socket;

        socket.addEventListener('open', () => {
          if (settled) {
            return;
          }
          settled = true;
          // Connection established → reset backoff so the next failure
          // restarts from the base delay.
          this.reconnectAttempt = 0;
          logger.info('[LanRelayClient] Connected to host');
          // Send a hello envelope so the host can record our clientId for logs.
          const hello: LanRelayEnvelope<LanRelayHelloPayload> = {
            v: 1,
            type: 'hello',
            id: randomUUID(),
            payload: { role: 'client', clientId: this.cfg.clientId },
          };
          socket.send(JSON.stringify(hello));
          resolve();
        });

        socket.addEventListener('message', (ev) => {
          // Bun's WebSocket may pass a Buffer for binary frames; coerce to string.
          this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
        });

        socket.addEventListener('error', () => {
          logger.warn('[LanRelayClient] WebSocket error');
          if (!settled) {
            settled = true;
            reject(new Error('LAN relay WebSocket connection failed'));
          }
        });

        socket.addEventListener('close', () => {
          logger.warn('[LanRelayClient] Disconnected from host');
          this.ws = null;
          if (!settled) {
            settled = true;
            reject(new Error('LAN relay WebSocket closed before open'));
          }
          // Self-sustaining reconnect loop: every clean disconnect schedules
          // the next attempt unless stop() was called.
          if (!this.stopped) {
            this.scheduleReconnect();
          }
        });
      } catch (e) {
        // `new WebSocket()` can throw synchronously (e.g. malformed URL).
        // No listeners are attached in that case, so we won't get a close event.
        if (!settled) {
          settled = true;
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
  }

  /**
   * Schedule a single delayed reconnect attempt with exponential backoff.
   * Idempotent: if a reconnect is already pending, this is a no-op so the
   * backoff exponent is incremented exactly once per failure cycle.
   */
  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer) {
      // Already scheduled — avoid double-incrementing the backoff exponent.
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // The close listener inside connectOnce() will call scheduleReconnect()
      // again on failure, so we don't need to re-schedule from this catch.
      void this.connectOnce().catch((err) => {
        logger.error('[LanRelayClient] Reconnect failed:', err);
      });
    }, delay);
  }

  /**
   * Dispatch an inbound envelope from the host.
   * Three message types are handled:
   *   - `pong`         : heartbeat reply, no action.
   *   - `inbound_message`: a NormalizedMessageEvent fanned out by the host;
   *                        re-injected into the local EventRouter so it flows
   *                        through the normal message pipeline.
   *   - `relay_ack`    : reply to a previous outbound relay_action; resolves
   *                      or rejects the matching pending promise.
   */
  private handleMessage(text: string): void {
    let env: LanRelayEnvelope;
    try {
      env = JSON.parse(text) as LanRelayEnvelope;
    } catch {
      logger.warn('[LanRelayClient] Invalid JSON from host');
      return;
    }
    if (env.v !== 1 || !env.type) {
      return;
    }

    if (env.type === 'pong') {
      return;
    }

    if (env.type === 'inbound_message') {
      // Synthetic inbound: drop the host-side event into the local pipeline.
      // From here on, the rest of the bot has no idea the event came over LAN.
      const p = env.payload as LanRelayInboundPayload | undefined;
      if (p?.event) {
        this.eventRouter.routeEvent(p.event);
      }
      return;
    }

    if (env.type === 'relay_ack') {
      // Match the ack back to the pending outbound relay call.
      const id = env.id ?? '';
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const ack = env.payload as { ok?: boolean; error?: string; result?: SendMessageResult } | undefined;
      if (ack?.ok) {
        pending.resolve(ack.result ?? {});
      } else {
        pending.reject(new Error(ack?.error ?? 'relay_ack failed'));
      }
    }
  }

  /**
   * Send a reply (text segments or forward node) by asking the host to
   * deliver it via the real IM connection. Resolves with the host's send
   * result, or rejects on timeout / host error / disconnected socket.
   * Called from SendSystem when no IM protocol is registered locally.
   */
  async relayOutboundSend(params: LanRelayOutboundParams): Promise<SendMessageResult> {
    const ws = this.ws;
    // Fail fast — we don't queue while disconnected; the upstream pipeline
    // surfaces the error to the user immediately.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('LAN relay is not connected to host');
    }

    // Each outbound relay carries a unique id so the matching ack can be
    // routed back to the right caller.
    const id = randomUUID();
    const payload: LanRelayActionPayload = {
      originalEvent: params.event,
      replySegments: params.segments,
      useForward: params.useForward,
      botSelfIdForForward: params.botSelfIdForForward,
    };

    const env: LanRelayEnvelope<LanRelayActionPayload> = {
      v: 1,
      type: 'relay_action',
      id,
      payload,
    };

    return new Promise<SendMessageResult>((resolve, reject) => {
      // Hard timeout in case the host never responds (network glitch, host crash).
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(new Error('LAN relay timeout waiting for relay_ack'));
        }
      }, RELAY_TIMEOUT_MS);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify(env));
      } catch (e) {
        // ws.send can throw if the socket transitions to closing between
        // the readyState check and the actual send — clean up the pending
        // entry so it doesn't sit around until the timeout fires.
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async stop(): Promise<void> {
    // Setting stopped first ensures any in-flight reconnect callbacks become no-ops.
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reject any pending relay calls so callers don't hang on shutdown.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('LAN relay stopped'));
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('[LanRelayClient] Stopped');
  }
}

/**
 * Build the final WebSocket URL we connect to.
 * - Defaults the path to `LAN_RELAY_WS_PATH` if the user only provided host:port.
 * - Embeds the auth token as a query parameter so the server can authenticate
 *   during the HTTP upgrade handshake (browsers can't set Authorization headers
 *   on WebSocket — query param is the portable choice).
 */
function buildClientWsUrl(connectUrl: string, token: string): string {
  const u = new URL(connectUrl);
  if (u.pathname === '/' || u.pathname === '') {
    u.pathname = LAN_RELAY_WS_PATH;
  }
  u.searchParams.set('token', token);
  return u.toString();
}

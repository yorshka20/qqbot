// LAN relay WebSocket client.
//
// Runs on instances configured with `lanRelay.instanceRole === 'client'`.
// Responsibilities (Phase 2):
//   1. Connect to a remote LanRelayHost over WebSocket (with auto-reconnect).
//   2. Send `client_register` after the hello handshake so the host can list us.
//   3. Receive `dispatch_to_client` envelopes — synthesize a private-message
//      NormalizedMessageEvent with the dispatch text + origin metadata, and
//      route it through the local EventRouter so commands/AI run on the
//      client side as if the user had typed locally.
//   4. Forward outbound replies to the host as `relay_action` envelopes,
//      using the stored origin to build the `target` field so the host knows
//      where to deliver the reply (private vs group, which IM platform).
//   5. Provide `sendToUser` / `reportToHost` APIs for client-side business
//      code to talk back to the user or send internal status to the host.
//
// Phase 1's `inbound_message` (broadcast every IM event from host) is gone:
// the client is silent unless the host explicitly dispatches.

import type { SendMessageResult } from '@/api/types';
import type { Config } from '@/core/config';
import type { LanRelayConfig } from '@/core/config/types/lanRelay';
import type { EventRouter } from '@/events/EventRouter';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';
import type { ILanRelayRuntime, LanRelayOutboundParams } from '../types/runtime';
import type {
  LanRelayActionPayload,
  LanRelayActionTarget,
  LanRelayDispatchAckPayload,
  LanRelayDispatchPayload,
  LanRelayEnvelope,
  LanRelayHelloAckPayload,
  LanRelayHelloPayload,
  LanRelayInternalReportPayload,
  LanRelayOriginContext,
  LanRelayRegisterPayload,
} from '../types/wire';
import { LAN_RELAY_WS_PATH } from '../types/wire';

/** Max time to wait for a `relay_ack` from the host before failing the send. */
const RELAY_TIMEOUT_MS = 120_000;
/** Initial reconnect delay; the actual delay grows exponentially up to RECONNECT_MAX_MS. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;
/** Synthetic protocol name used in dispatch events; SendSystem detects this. */
export const LAN_DISPATCH_PROTOCOL = 'lan-dispatch' as const;

/** In-flight outbound relay request awaiting an ack from the host, keyed by envelope id. */
type Pending = {
  resolve: (v: SendMessageResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LanRelayClient implements ILanRelayRuntime {
  private readonly cfg: LanRelayConfig;
  private readonly config: Config;
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
  /** Wall-clock startup time, sent in client_register so host can show uptime. */
  private readonly startedAt: number;
  /**
   * Most recent dispatch origin (覆盖式 — A5 decision).
   * Updated every time a dispatch_to_client arrives. SendSystem reads this
   * via getCurrentOrigin() to build the relay_action.target field.
   */
  private currentOrigin: LanRelayOriginContext | null = null;
  /** Cached clientId for use in internal_report payloads. */
  private readonly clientId: string;

  constructor(
    config: Config,
    private readonly eventRouter: EventRouter,
  ) {
    this.config = config;
    const lr = config.getLanRelayConfig();
    if (!lr) {
      throw new Error('LanRelayClient: lanRelay config missing');
    }
    this.cfg = lr;
    const url = lr.connectUrl;
    const tok = lr.token;
    if (!url || !tok) {
      throw new Error('LanRelayClient: connectUrl and token are required (validated by Config)');
    }
    if (!lr.clientId) {
      throw new Error('LanRelayClient: clientId is required for Phase 2 dispatch model');
    }
    this.clientId = lr.clientId;
    this.connectUrlResolved = buildClientWsUrl(url, tok);
    this.startedAt = Date.now();
  }

  // ── ILanRelayRuntime — role checks ────────────────────────────────────

  isClientMode(): boolean {
    return true;
  }

  isHostMode(): boolean {
    return false;
  }

  getCurrentOrigin(): LanRelayOriginContext | null {
    return this.currentOrigin;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;
    // Fire-and-forget the initial attempt: if the host is briefly down at boot,
    // we still want the client process to come up and reconnect in the background.
    this.connectOnce().catch((err) => {
      logger.warn('[LanRelayClient] Initial connect failed, will retry in background:', err);
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
      let settled = false;
      try {
        const socket = new WebSocket(this.connectUrlResolved);
        this.ws = socket;

        socket.addEventListener('open', () => {
          if (settled) return;
          settled = true;
          this.reconnectAttempt = 0;
          logger.info('[LanRelayClient] Connected to host');

          // Send hello first.
          const hello: LanRelayEnvelope<LanRelayHelloPayload> = {
            v: 1,
            type: 'hello',
            id: randomUUID(),
            payload: { role: 'client', clientId: this.clientId },
          };
          socket.send(JSON.stringify(hello));

          // Then immediately send client_register so the host registry is populated.
          // We don't wait for hello_ack here — if the host rejects the hello (e.g.
          // duplicate clientId), the close handler will catch it.
          this.sendRegister(socket);

          // F3 auto report: connected.
          this.autoReport('info', `client connected (uptime ${Math.floor((Date.now() - this.startedAt) / 1000)}s)`);

          resolve();
        });

        socket.addEventListener('message', (ev) => {
          this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
        });

        socket.addEventListener('error', () => {
          logger.warn('[LanRelayClient] WebSocket error');
          if (!settled) {
            settled = true;
            reject(new Error('LAN relay WebSocket connection failed'));
          }
        });

        socket.addEventListener('close', (ev) => {
          // Code 4002 = host rejected duplicate clientId. Surface a fatal error.
          if (ev.code === 4002) {
            logger.error(`[LanRelayClient] Host rejected connection: ${ev.reason || 'duplicate clientId'}`);
            logger.error('[LanRelayClient] Fix lanRelay.clientId in config and restart.');
            this.stopped = true;
          } else {
            logger.warn(`[LanRelayClient] Disconnected from host (code=${ev.code})`);
          }

          this.ws = null;
          if (!settled) {
            settled = true;
            reject(new Error(`LAN relay WebSocket closed before open (code=${ev.code})`));
          }
          if (!this.stopped) {
            this.scheduleReconnect();
          }
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
  }

  /**
   * Auto report (F3 decision: lifecycle events + fatal errors).
   * Sends an internal_report to the host on connect/disconnect/start/stop.
   * Manual reports go through the public reportToHost API.
   */
  private autoReport(level: 'debug' | 'info' | 'warn' | 'error', text: string): void {
    // reportToHost is best-effort and silent on failure, perfect for auto reports.
    void this.reportToHost(level, text);
  }

  /** Build and send the client_register envelope. */
  private sendRegister(socket: WebSocket): void {
    // lanAddress comes from config.lanRelay.publicAddress (D1 decision: config-only).
    const lanAddress = this.cfg.publicAddress;
    if (!lanAddress) {
      logger.error('[LanRelayClient] lanRelay.publicAddress is required for client mode');
      throw new Error('lanRelay.publicAddress is required for client mode');
    }

    const payload: LanRelayRegisterPayload = {
      clientId: this.clientId,
      label: this.cfg.clientLabel,
      lanAddress,
      startedAt: this.startedAt,
      enabledPlugins: this.config.getEnabledPluginNames(),
    };
    const env: LanRelayEnvelope<LanRelayRegisterPayload> = {
      v: 1,
      type: 'client_register',
      id: randomUUID(),
      payload,
    };
    try {
      socket.send(JSON.stringify(env));
      logger.info(`[LanRelayClient] Registered as ${this.clientId} (${lanAddress})`);
    } catch (e) {
      logger.warn('[LanRelayClient] Failed to send client_register:', e);
    }
  }

  /**
   * Schedule a single delayed reconnect attempt with exponential backoff.
   * Idempotent: if a reconnect is already pending, this is a no-op.
   */
  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce().catch((err) => {
        logger.error('[LanRelayClient] Reconnect failed:', err);
      });
    }, delay);
  }

  // ── Inbound message handling ─────────────────────────────────────────

  /**
   * Dispatch an inbound envelope from the host.
   * Phase 2 message types:
   *   - pong              : heartbeat reply, no action.
   *   - hello_ack         : log accept/reject (close listener handles fatal).
   *   - dispatch_to_client: synthesize event + route through local EventRouter.
   *   - relay_ack         : reply to a previous outbound relay_action.
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

    if (env.type === 'hello_ack') {
      const p = env.payload as LanRelayHelloAckPayload | undefined;
      if (p?.accepted === false) {
        logger.error(`[LanRelayClient] Host rejected hello: ${p.reason ?? 'unknown reason'}`);
      }
      return;
    }

    if (env.type === 'dispatch_to_client') {
      const p = env.payload as LanRelayDispatchPayload | undefined;
      if (!p?.text || !p.origin || !p.dispatchId) {
        logger.warn('[LanRelayClient] dispatch_to_client missing required fields');
        return;
      }
      this.handleDispatch(p);
      return;
    }

    if (env.type === 'relay_ack') {
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
   * Process a dispatch from the host:
   *   1. Store the origin for return-path routing.
   *   2. Synthesize a NormalizedMessageEvent (private chat, lan-dispatch protocol).
   *   3. Route it through EventRouter so the normal command/AI pipeline runs.
   *   4. Send dispatch_ack back so the host knows we received it.
   */
  private handleDispatch(payload: LanRelayDispatchPayload): void {
    // 1. Store origin (覆盖式 — A5 decision).
    this.currentOrigin = payload.origin;
    logger.info(
      `[LanRelayClient] Dispatch received (id=${payload.dispatchId}, from=${payload.origin.protocol}:${payload.origin.userId})`,
    );

    // 2. Synthesize NormalizedMessageEvent.
    // We use the dispatch userId as the synthetic event userId so commands
    // see "the right user" and can apply owner/admin permission checks.
    const event: NormalizedMessageEvent = {
      id: `lan-dispatch-${payload.dispatchId}`,
      type: 'message',
      timestamp: Date.now(),
      // SendSystem detects LAN_DISPATCH_PROTOCOL and routes outbound through relay.
      protocol: LAN_DISPATCH_PROTOCOL as unknown as NormalizedMessageEvent['protocol'],
      messageType: 'private',
      userId: payload.origin.userId,
      message: payload.text,
      rawMessage: payload.text,
      messageId: payload.dispatchId,
      segments: [{ type: 'text', data: { text: payload.text } }],
      sender: {
        userId: payload.origin.userId,
        nickname: 'lan-dispatcher',
      },
    };

    // 3. Inject into local EventRouter — runs the full command pipeline.
    this.eventRouter.routeEvent(event);

    // 4. Ack the dispatch (transport-level only).
    const ack: LanRelayEnvelope<LanRelayDispatchAckPayload> = {
      v: 1,
      type: 'dispatch_ack',
      id: payload.dispatchId,
      payload: { dispatchId: payload.dispatchId, ok: true },
    };
    try {
      this.ws?.send(JSON.stringify(ack));
    } catch (e) {
      logger.warn('[LanRelayClient] Failed to send dispatch_ack:', e);
    }
  }

  // ── Outbound APIs ────────────────────────────────────────────────────

  /**
   * Send a reply by asking the host to deliver it via the real IM connection.
   * Called from SendSystem when no IM protocol is registered locally.
   *
   * Phase 2: if SendSystem stamped a target on the params (via origin), it
   * gets used as the host-side target; otherwise we fall back to the
   * Phase 1 originalEvent path.
   */
  async relayOutboundSend(params: LanRelayOutboundParams): Promise<SendMessageResult> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('LAN relay is not connected to host');
    }

    // Build target from current origin if available — this is the case for
    // any reply to a dispatched command.
    const target = this.buildTargetFromOrigin();

    const id = randomUUID();
    const payload: LanRelayActionPayload = {
      originalEvent: params.event,
      replySegments: params.segments,
      useForward: params.useForward,
      botSelfIdForForward: params.botSelfIdForForward,
      target,
    };

    const env: LanRelayEnvelope<LanRelayActionPayload> = {
      v: 1,
      type: 'relay_action',
      id,
      payload,
    };

    return new Promise<SendMessageResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(new Error('LAN relay timeout waiting for relay_ack'));
        }
      }, RELAY_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      try {
        ws.send(JSON.stringify(env));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Ask host to deliver a message to the user (default: dispatch originator).
   * Used by client-side business code (e.g. cron tasks, agent task callbacks)
   * to talk to the user without going through SendSystem.
   *
   * Per E2 decision: if no origin available, send to bot owner via the
   * default reply target (configured by host). Currently we just send the
   * relay_action with no target and let host fall back; in practice the
   * host always has at least owner config.
   */
  async sendToUser(segments: MessageSegment[]): Promise<SendMessageResult> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('LAN relay is not connected to host');
    }

    let target = this.buildTargetFromOrigin();
    if (!target) {
      // No origin — fall back to owner. Host will resolve from defaultReplyTarget
      // in its config. We pass a synthetic target with no userId so host knows
      // to use its fallback.
      target = {
        protocol: 'milky', // placeholder; host will override via fallback
        chatType: 'private',
        fromClientId: this.clientId,
      };
    } else {
      target.fromClientId = this.clientId;
    }

    // Build a minimal synthetic event for the relay_action — host won't use
    // it because target is set, but the schema requires it.
    const syntheticEvent: NormalizedMessageEvent = {
      id: `lan-sendtouser-${randomUUID()}`,
      type: 'message',
      timestamp: Date.now(),
      protocol: LAN_DISPATCH_PROTOCOL as unknown as NormalizedMessageEvent['protocol'],
      messageType: 'private',
      userId: target.userId ?? 0,
      message: '',
    };

    return this.relayOutboundSend({
      segments,
      event: syntheticEvent,
      useForward: false,
    });
  }

  /**
   * Send an internal status report to the host. No IM, just a log line
   * persisted to the host's sqlite for `/lan log`.
   */
  async reportToHost(level: 'debug' | 'info' | 'warn' | 'error', text: string): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Don't throw — internal reports are best-effort. The client can run
      // when the host is unreachable, and reports just get dropped.
      logger.debug('[LanRelayClient] reportToHost skipped: not connected');
      return;
    }
    const payload: LanRelayInternalReportPayload = {
      ts: Date.now(),
      clientId: this.clientId,
      level,
      text,
    };
    const env: LanRelayEnvelope<LanRelayInternalReportPayload> = {
      v: 1,
      type: 'internal_report',
      payload,
    };
    try {
      ws.send(JSON.stringify(env));
    } catch (e) {
      logger.warn('[LanRelayClient] Failed to send internal_report:', e);
    }
  }

  /**
   * Build a relay_action target from the current dispatch origin.
   * Returns null if no origin is set (client hasn't received any dispatch yet).
   *
   * Per E3 decision: client always replies in private (default IM behavior);
   * host knows the dispatch loop and decides if a group fan-out is needed.
   */
  private buildTargetFromOrigin(): LanRelayActionTarget | undefined {
    const origin = this.currentOrigin;
    if (!origin) {
      return undefined;
    }
    return {
      protocol: origin.protocol,
      chatType: 'private',
      userId: origin.userId,
    };
  }

  // ── Shutdown ─────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
 *   during the HTTP upgrade handshake.
 */
function buildClientWsUrl(connectUrl: string, token: string): string {
  const u = new URL(connectUrl);
  if (u.pathname === '/' || u.pathname === '') {
    u.pathname = LAN_RELAY_WS_PATH;
  }
  u.searchParams.set('token', token);
  return u.toString();
}

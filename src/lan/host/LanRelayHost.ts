// LAN relay WebSocket host.
//
// Runs on instances configured with `lanRelay.instanceRole === 'host'`.
// Responsibilities:
//   1. Listen on a LAN port for LanRelayClient connections (token-authenticated).
//   2. Maintain a registry of connected clients keyed by clientId.
//   3. Dispatch user commands to specific clients via `dispatch_to_client`.
//   4. Execute `relay_action` envelopes from clients — including origin-aware
//      target routing (Phase 2) so replies land in the correct IM chat.
//   5. Persist `internal_report` envelopes to sqlite for `/lan log`.
//
// Phase 2 removes the Phase 1 "broadcast every IM message" behavior.
// The dispatch model is explicit: host only forwards to a client when the
// user issues `/lan @<clientId> ...`.
//
// Independent of Agent Cluster (ContextHub) — runs its own Bun.serve.

import type { Database } from 'bun:sqlite';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { SendMessageResult } from '@/api/types';
import type { Config } from '@/core/config';
import type { LanRelayConfig } from '@/core/config/types/lanRelay';
import type { EventRouter } from '@/events/EventRouter';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import type { ILanRelayRuntime } from '../types/runtime';
import type { LanInternalReportRow } from './LanInternalReportStore';
import { LanInternalReportStore } from './LanInternalReportStore';
import type {
  LanRelayActionPayload,
  LanRelayDispatchPayload,
  LanRelayEnvelope,
  LanRelayHelloAckPayload,
  LanRelayHelloPayload,
  LanRelayInternalReportPayload,
  LanRelayOriginContext,
  LanRelayRegisterPayload,
} from '../types/wire';
import { LAN_RELAY_WS_PATH } from '../types/wire';
import type { ClientData, ClientEntry } from './registry';

export class LanRelayHost implements ILanRelayRuntime {
  /** Underlying Bun HTTP/WebSocket server; null until start() and after stop(). */
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** Client registry keyed by clientId. Replaces Phase 1's anonymous Set<ws>. */
  private readonly clientsById = new Map<string, ClientEntry>();
  private readonly cfg: LanRelayConfig;
  private readonly token: string;
  private readonly messageAPI: MessageAPI;
  /** Store for client internal_report envelopes; null when no rawDb available. */
  private readonly reportStore: LanInternalReportStore | null;

  constructor(
    config: Config,
    _eventRouter: EventRouter,
    messageAPI: MessageAPI,
    rawDb: Database | null = null,
  ) {
    const lr = config.getLanRelayConfig();
    if (!lr) {
      throw new Error('LanRelayHost: lanRelay config missing');
    }
    this.cfg = lr;
    if (!lr.token) {
      throw new Error('LanRelayHost: token is required (validated by Config)');
    }
    this.token = lr.token;
    this.messageAPI = messageAPI;
    this.reportStore = rawDb ? new LanInternalReportStore(rawDb) : null;
  }

  // ── ILanRelayRuntime — role checks ────────────────────────────────────

  isClientMode(): boolean {
    return false;
  }

  isHostMode(): boolean {
    return true;
  }

  /** Host does not relay outbound — it IS the IM-connected node. */
  relayOutboundSend(): Promise<SendMessageResult> {
    return Promise.reject(new Error('LanRelayHost: relayOutboundSend is only valid on client'));
  }

  /** Host does not send to user via relay. */
  sendToUser(_segments: MessageSegment[]): Promise<SendMessageResult> {
    return Promise.reject(new Error('LanRelayHost: sendToUser is only valid on client'));
  }

  /** Host does not report to itself. */
  reportToHost(_level: 'debug' | 'info' | 'warn' | 'error', _text: string): Promise<void> {
    return Promise.reject(new Error('LanRelayHost: reportToHost is only valid on client'));
  }

  /** Host has no dispatch origin. */
  getCurrentOrigin(): LanRelayOriginContext | null {
    return null;
  }

  // ── Public API for LanControlPlugin ──────────────────────────────────

  /** Return a snapshot of all registered clients (for /lan list). */
  listClients(): ClientEntry[] {
    return Array.from(this.clientsById.values());
  }

  /** Find a client by id. */
  getClient(clientId: string): ClientEntry | undefined {
    return this.clientsById.get(clientId);
  }

  /**
   * Send a dispatch_to_client envelope to a specific client.
   * Returns false if the client is not connected.
   */
  dispatchToClient(clientId: string, payload: LanRelayDispatchPayload): boolean {
    const entry = this.clientsById.get(clientId);
    if (!entry) {
      return false;
    }
    const env: LanRelayEnvelope<LanRelayDispatchPayload> = {
      v: 1,
      type: 'dispatch_to_client',
      id: payload.dispatchId,
      payload,
    };
    try {
      entry.ws.send(JSON.stringify(env));
      entry.lastSeenAt = Date.now();
      return true;
    } catch {
      this.clientsById.delete(clientId);
      return false;
    }
  }

  /**
   * Query the most recent N internal reports for a client.
   * Returns an empty array if the host has no DB-backed report store.
   */
  getReports(
    clientId: string,
    opts?: { limit?: number; level?: 'debug' | 'info' | 'warn' | 'error' },
  ): LanInternalReportRow[] {
    if (!this.reportStore) {
      return [];
    }
    return this.reportStore.query(clientId, opts);
  }

  /** Whether the host has a DB-backed report store wired up. */
  hasReportStore(): boolean {
    return this.reportStore !== null;
  }

  /** Force-disconnect a client by id (for /lan kick). */
  kickClient(clientId: string): boolean {
    const entry = this.clientsById.get(clientId);
    if (!entry) {
      return false;
    }
    this.clientsById.delete(clientId);
    try {
      entry.ws.close(4001, 'Kicked by host');
    } catch {
      // Already closed.
    }
    logger.info(`[LanRelayHost] Kicked client: ${clientId}`);
    return true;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const port = this.cfg.listenPort;
    const hostname = this.cfg.listenHost ?? '0.0.0.0';
    if (port == null || Number.isNaN(Number(port))) {
      throw new Error('lanRelay.listenPort is required for host mode');
    }

    const token = this.token;
    const clientsById = this.clientsById;
    const messageAPI = this.messageAPI;
    const reportStore = this.reportStore;

    this.server = Bun.serve<ClientData>({
      port,
      hostname,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname !== LAN_RELAY_WS_PATH) {
          return new Response('Not Found', { status: 404 });
        }
        const qToken =
          url.searchParams.get('token') ?? req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (qToken !== token) {
          return new Response('Unauthorized', { status: 401 });
        }
        const upgraded = server.upgrade(req, { data: { authenticated: true } });
        if (upgraded) {
          return undefined;
        }
        return new Response('Upgrade failed', { status: 500 });
      },
      websocket: {
        open(_ws) {
          logger.info('[LanRelayHost] Client connected (awaiting hello)');
        },
        message(ws, message) {
          void handleHostClientMessage(ws, message, messageAPI, clientsById, reportStore);
        },
        close(ws) {
          if (ws.data?.clientId) {
            const entry = clientsById.get(ws.data.clientId);
            if (entry && entry.ws === ws) {
              clientsById.delete(ws.data.clientId);
              logger.info(`[LanRelayHost] Client disconnected: ${ws.data.clientId}`);
            }
          } else {
            logger.info('[LanRelayHost] Unauthenticated client disconnected');
          }
        },
      },
    });

    logger.info(`[LanRelayHost] Listening on ws://${hostname}:${port}${LAN_RELAY_WS_PATH}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.clientsById.clear();
    logger.info('[LanRelayHost] Stopped');
  }
}

// ── Per-message handler ──────────────────────────────────────────────────

/**
 * Per-message dispatcher for an authenticated client socket. Handles:
 *   - ping            : reply with pong
 *   - hello           : record clientId, reject duplicates
 *   - client_register : store metadata into the registry
 *   - relay_action    : execute outbound IM send via MessageAPI
 *   - internal_report : persist to sqlite (Step 7)
 *   - dispatch_ack    : no-op for now
 */
async function handleHostClientMessage(
  ws: import('bun').ServerWebSocket<ClientData>,
  message: string | Buffer,
  messageAPI: MessageAPI,
  clientsById: Map<string, ClientEntry>,
  reportStore: LanInternalReportStore | null,
): Promise<void> {
  const text = typeof message === 'string' ? message : message.toString();
  let parsed: LanRelayEnvelope;
  try {
    parsed = JSON.parse(text) as LanRelayEnvelope;
  } catch {
    logger.warn('[LanRelayHost] Invalid JSON from client');
    return;
  }

  if (parsed.v !== 1 || !parsed.type) {
    return;
  }

  if (parsed.type === 'ping') {
    if (ws.data?.clientId) {
      const entry = clientsById.get(ws.data.clientId);
      if (entry) entry.lastSeenAt = Date.now();
    }
    ws.send(JSON.stringify({ v: 1, type: 'pong', id: parsed.id } satisfies LanRelayEnvelope));
    return;
  }

  if (parsed.type === 'hello') {
    const p = parsed.payload as LanRelayHelloPayload | undefined;
    const clientId = p?.clientId;

    // B1 decision: reject new connection if clientId already connected.
    if (clientId && clientsById.has(clientId)) {
      const ack: LanRelayEnvelope<LanRelayHelloAckPayload> = {
        v: 1,
        type: 'hello_ack',
        id: parsed.id,
        payload: {
          accepted: false,
          reason: `clientId "${clientId}" is already connected. Change your lanRelay.clientId and restart.`,
        },
      };
      ws.send(JSON.stringify(ack));
      ws.close(4002, `Duplicate clientId: ${clientId}`);
      return;
    }

    if (clientId && ws.data) {
      ws.data.clientId = clientId;
    }
    const ack: LanRelayEnvelope<LanRelayHelloAckPayload> = {
      v: 1,
      type: 'hello_ack',
      id: parsed.id,
      payload: { accepted: true },
    };
    ws.send(JSON.stringify(ack));
    return;
  }

  if (parsed.type === 'client_register') {
    const p = parsed.payload as LanRelayRegisterPayload | undefined;
    if (!p?.clientId || !p.lanAddress) {
      logger.warn('[LanRelayHost] client_register missing clientId or lanAddress');
      return;
    }

    if (ws.data?.clientId && ws.data.clientId !== p.clientId) {
      logger.warn(
        `[LanRelayHost] client_register clientId (${p.clientId}) differs from hello (${ws.data.clientId})`,
      );
      return;
    }

    // Guard duplicate (should not happen if hello was correct).
    const existing = clientsById.get(p.clientId);
    if (existing && existing.ws !== ws) {
      logger.warn(`[LanRelayHost] Duplicate clientId in register: ${p.clientId}`);
      return;
    }

    const now = Date.now();
    const entry: ClientEntry = {
      ws,
      clientId: p.clientId,
      label: p.label,
      lanAddress: p.lanAddress,
      startedAt: p.startedAt,
      connectedAt: now,
      lastSeenAt: now,
      enabledPlugins: p.enabledPlugins,
    };
    clientsById.set(p.clientId, entry);
    if (ws.data) ws.data.clientId = p.clientId;
    logger.info(`[LanRelayHost] Client registered: ${p.clientId} (${p.lanAddress})`);
    return;
  }

  if (parsed.type === 'internal_report') {
    const p = parsed.payload as LanRelayInternalReportPayload | undefined;
    if (!p?.clientId || !p.text) {
      return;
    }
    const entry = clientsById.get(p.clientId);
    if (entry) entry.lastSeenAt = Date.now();
    // Persist to sqlite (best-effort) and log to console for live monitoring.
    if (reportStore) {
      reportStore.insert(p);
    }
    logger.info(`[LanRelayHost] Report from ${p.clientId} [${p.level}]: ${p.text}`);
    return;
  }

  if (parsed.type === 'dispatch_ack') {
    // Client acknowledges a dispatch. No-op for now.
    return;
  }

  if (parsed.type === 'relay_action') {
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

    if (ws.data?.clientId) {
      const entry = clientsById.get(ws.data.clientId);
      if (entry) entry.lastSeenAt = Date.now();
    }

    try {
      let result: SendMessageResult;

      // Phase 2: if the payload has an explicit `target`, use direct
      // sendPrivateMessage / sendGroupMessage instead of sendFromContext
      // (which would try to route based on the synthetic dispatch event).
      if (payload.target) {
        const { protocol, chatType, userId, groupId, fromClientId } = payload.target;
        // Add a "[from <clientId>]" prefix so the user knows who's talking.
        const segments = fromClientId
          ? prefixFirstTextSegment(payload.replySegments, `[${fromClientId}] `)
          : payload.replySegments;

        if (chatType === 'private' && userId != null) {
          const msgId = await messageAPI.sendPrivateMessage(userId, segments, protocol);
          result = { message_id: msgId };
        } else if (chatType === 'group' && groupId != null) {
          const msgId = await messageAPI.sendGroupMessage(groupId, segments, protocol);
          result = { message_id: msgId };
        } else {
          throw new Error(`Invalid target: chatType=${chatType}, userId=${userId}, groupId=${groupId}`);
        }
      } else if (payload.useForward) {
        const botSelfId = payload.botSelfIdForForward;
        if (botSelfId == null || Number.isNaN(Number(botSelfId)) || botSelfId <= 0) {
          throw new Error('Forward relay requires botSelfIdForForward');
        }
        result = await messageAPI.sendForwardFromContext(
          [{ segments: payload.replySegments, senderName: 'Bot' }],
          payload.originalEvent,
          60000,
          { botUserId: botSelfId },
        );
      } else {
        result = await messageAPI.sendFromContext(payload.replySegments, payload.originalEvent, 60000);
      }

      ws.send(
        JSON.stringify({
          v: 1,
          type: 'relay_ack',
          id,
          payload: { ok: true, result },
        } satisfies LanRelayEnvelope),
      );
    } catch (err) {
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

/**
 * Prepend a text prefix to the first text segment's content.
 * Returns a new array (no mutation). If no text segment exists, prepends one.
 */
function prefixFirstTextSegment(segments: MessageSegment[], prefix: string): MessageSegment[] {
  const result = [...segments];
  for (let i = 0; i < result.length; i++) {
    if (result[i].type === 'text') {
      const seg = result[i] as { type: 'text'; data: { text: string } };
      result[i] = { type: 'text', data: { text: prefix + seg.data.text } };
      return result;
    }
  }
  // No text segment — insert one at the front.
  result.unshift({ type: 'text', data: { text: prefix } });
  return result;
}

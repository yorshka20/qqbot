// LAN relay wire protocol — shared between host and client.
//
// All envelopes are JSON-encoded `LanRelayEnvelope<T>` values sent over a
// single WebSocket connection. Versioning is encoded in `v` so the host can
// reject envelopes from incompatible client builds.
//
// Phase 2 model (replaces Phase 1 broadcast fan-out):
//   1. Client connects → sends `client_register` with metadata (lanAddress,
//      plugins, uptime). Host stores it in a registry indexed by clientId.
//   2. User on host issues `/lan @<clientId> <text>` → host sends a
//      `dispatch_to_client` envelope to that specific client only.
//   3. Client receives dispatch → synthesizes a NormalizedMessageEvent (with
//      `lanOrigin` metadata) and routes it through its own EventRouter, so
//      commands/AI run on the client side as if the user had typed locally.
//   4. Client wants to talk back → uses `relay_action` (re-using Phase 1
//      transport but now with origin-aware `target` field) so host knows
//      which IM platform / chat to send the reply through.
//   5. Client wants to log internal status (no IM) → `internal_report`
//      envelope; host writes to a sqlite table for `/lan log`.

import type { SendMessageResult } from '@/api/types';
import type { ProtocolName } from '@/core/config';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';

/**
 * WebSocket upgrade path. The host's `fetch` handler only accepts upgrades
 * for this path; the client's `connectUrl` must resolve to it (the client
 * helper auto-fills the path if the user only configured host:port).
 */
export const LAN_RELAY_WS_PATH = '/lan-relay';

/**
 * Discriminator for LanRelayEnvelope.type.
 *
 * Handshake / lifecycle:
 *   - hello / hello_ack       : initial token-validated handshake
 *   - client_register         : client → host metadata after hello (Phase 2)
 *
 * Dispatch (host → specific client, Phase 2 model):
 *   - dispatch_to_client      : host asks one client to run a synthesized command
 *   - dispatch_ack            : client acknowledges receipt (not result)
 *
 * Outbound (client → host → IM):
 *   - relay_action            : client asks host to send an outbound IM reply
 *   - relay_ack               : host's response to a relay_action
 *   - relay_error             : malformed relay_action rejected up-front
 *
 * Internal status (client → host, no IM):
 *   - internal_report         : log line / status update for `/lan log`
 *
 * Liveness:
 *   - ping / pong             : optional liveness probe
 */
export type LanRelayWireType =
  | 'hello'
  | 'hello_ack'
  | 'client_register'
  | 'dispatch_to_client'
  | 'dispatch_ack'
  | 'relay_action'
  | 'relay_ack'
  | 'relay_error'
  | 'internal_report'
  | 'ping'
  | 'pong';

/**
 * Generic envelope. `id` is used to correlate request/reply pairs (e.g.
 * relay_action → relay_ack); `payload` shape depends on `type`.
 */
export interface LanRelayEnvelope<T = unknown> {
  /** Wire-protocol version. Bump only on backwards-incompatible changes. */
  v: 1;
  type: LanRelayWireType;
  /** Optional correlation id for request/reply matching. */
  id?: string;
  payload?: T;
}

/** First message after a successful WebSocket upgrade — client identifies itself. */
export interface LanRelayHelloPayload {
  role: 'host' | 'client';
  /** Free-form client identifier shown in host logs (optional). */
  clientId?: string;
}

/**
 * Hello ack payload — host can reject a client even after token validation
 * (e.g. duplicate clientId). Client treats `accepted=false` as fatal and
 * surfaces the reason so the operator can fix the config and restart.
 */
export interface LanRelayHelloAckPayload {
  accepted: boolean;
  reason?: string;
}

/**
 * Client → host registration. Sent immediately after `hello`. Host stores
 * this in its registry so `/lan list` can render the available clients and
 * `/lan @<clientId>` knows where to dispatch.
 */
export interface LanRelayRegisterPayload {
  /** Stable id; must be unique across connected clients. Used by /lan @<id>. */
  clientId: string;
  /** Optional human-readable label shown in /lan list output. */
  label?: string;
  /** LAN-reachable address (e.g. 192.168.50.42). Used to render URLs in /lan list. */
  lanAddress: string;
  /** Wall-clock startup time in ms; host computes uptime as (now - startedAt). */
  startedAt: number;
  /** Names of plugins actually enabled on the client. Optional; for /lan list. */
  enabledPlugins?: string[];
}

/**
 * Origin context attached to every dispatch. The client stores this so its
 * own SendSystem can route the reply back to the correct IM chat via
 * `relay_action.target`.
 *
 * "覆盖式" — only the most recent dispatch is remembered. Concurrent
 * dispatches will reuse the latest origin (acceptable for the current
 * single-task workflow).
 */
export interface LanRelayOriginContext {
  /** IM platform the user issued the dispatch from (e.g. 'milky', 'discord'). */
  protocol: ProtocolName;
  /** User who issued the dispatch (their IM-side user id). */
  userId: string | number;
  /** Group context if the dispatch came from a group; absent for private. */
  groupId?: string | number;
  /** Original message id, useful for reply quoting. */
  sourceMessageId?: string | number;
  /** ms timestamp the host stamped at dispatch time. */
  dispatchedAt: number;
}

/**
 * Host → client dispatch payload. The text is what the user typed AFTER the
 * `/lan @<clientId>` prefix; the client treats it as a fresh user message.
 */
export interface LanRelayDispatchPayload {
  /** Raw text to feed into the client's command/AI pipeline. */
  text: string;
  /** Where the dispatch originated, for return-path routing. */
  origin: LanRelayOriginContext;
  /** Unique id for this dispatch — also embedded in the synthetic event. */
  dispatchId: string;
}

/** Client → host ack of a dispatch (transport-level only, not task result). */
export interface LanRelayDispatchAckPayload {
  dispatchId: string;
  ok: boolean;
  error?: string;
}

/**
 * Client → host outbound send request. Phase 2 adds `target` so the host
 * knows where to send WITHOUT relying on `originalEvent` (which is the
 * synthetic dispatch event, not a real IM message).
 */
export interface LanRelayActionPayload {
  /** Synthetic / original event used by sendFromContext to derive defaults. */
  originalEvent: NormalizedMessageEvent;
  replySegments: MessageSegment[];
  /** When true, host calls sendForwardFromContext (forward node), else sendFromContext. */
  useForward: boolean;
  /** Required when useForward=true — bot's own QQ id used as the forward node sender. */
  botSelfIdForForward?: number;
  /**
   * Phase 2: explicit return-path target derived from the dispatch origin.
   * When present, host uses this to construct the SendTarget instead of
   * inferring from `originalEvent`.
   */
  target?: LanRelayActionTarget;
}

/**
 * Explicit reply target on the host side.
 */
export interface LanRelayActionTarget {
  protocol: ProtocolName;
  chatType: 'private' | 'group';
  userId?: string | number;
  groupId?: string | number;
  /** Optional clientId of the originating client — host renders "from <client>" prefix. */
  fromClientId?: string;
}

/**
 * Host → client reply to a previous relay_action.
 */
export interface LanRelayAckPayload {
  ok: boolean;
  error?: string;
  result?: SendMessageResult;
}

/**
 * Client → host internal status report. Persisted to sqlite on the host
 * and queryable via `/lan log`.
 */
export interface LanRelayInternalReportPayload {
  ts: number;
  clientId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  text: string;
}

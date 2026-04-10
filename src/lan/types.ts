// LAN relay wire protocol — shared between host and client.
//
// All envelopes are JSON-encoded `LanRelayEnvelope<T>` values sent over a
// single WebSocket connection. Versioning is encoded in `v` so the host can
// reject envelopes from incompatible client builds.

import type { SendMessageResult } from '@/api/types';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';

/**
 * WebSocket upgrade path. The host's `fetch` handler only accepts upgrades
 * for this path; the client's `connectUrl` must resolve to it (the client
 * helper auto-fills the path if the user only configured host:port).
 */
export const LAN_RELAY_WS_PATH = '/lan-relay';

/**
 * Discriminator for LanRelayEnvelope.type. Each value is a distinct
 * direction/intent on the wire — see the LanRelay*Payload interfaces below
 * for the matching shapes:
 *   - hello / hello_ack    : initial handshake (client → host → client)
 *   - inbound_message      : host fan-out of an IM message (host → client)
 *   - relay_action         : client asks host to send an outbound IM reply
 *   - relay_ack            : host's response to a relay_action
 *   - relay_error          : malformed relay_action rejected up-front
 *   - ping / pong          : optional liveness probe
 */
export type LanRelayWireType =
  | 'hello'
  | 'hello_ack'
  | 'inbound_message'
  | 'relay_action'
  | 'relay_ack'
  | 'relay_error'
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

/** Host → client fan-out of an IM message that arrived on the host's IM connection. */
export interface LanRelayInboundPayload {
  /** JSON-serializable normalized message event (from host IM). */
  event: NormalizedMessageEvent;
}

/**
 * Client → host outbound send request. The host re-runs the matching
 * MessageAPI call against its real IM adapter and returns the result via
 * relay_ack.
 */
export interface LanRelayActionPayload {
  /** Original message context for MessageAPI.sendFromContext / sendForwardFromContext. */
  originalEvent: NormalizedMessageEvent;
  replySegments: MessageSegment[];
  /** When true, host calls sendForwardFromContext (forward node), else sendFromContext (plain reply). */
  useForward: boolean;
  /** Required when useForward=true — bot's own QQ id used as the forward node sender. */
  botSelfIdForForward?: number;
}

/**
 * Host → client reply to a previous relay_action. `result` carries the IM
 * adapter's send result on success; `error` is set when ok=false.
 */
export interface LanRelayAckPayload {
  ok: boolean;
  error?: string;
  result?: SendMessageResult;
}

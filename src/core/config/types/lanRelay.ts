// LAN relay / remote control configuration.
//
// Independent of both IM protocols (QQ/Discord/etc.) and Agent Cluster — the
// LAN relay is a separate transport that lets a "client" instance run the
// full bot stack without holding an IM session, by piggy-backing on a "host"
// instance that does. See src/lan/ for the implementation and the project
// plan in .cursor/plans/lan_websocket_host-client_cluster_*.plan.md for the
// design rationale ("each deploy keeps the same full config.jsonc; only the
// instanceRole and lanRelay endpoints differ between machines").

/**
 * Distinguishes the two LAN relay deployment modes:
 *   - host  : runs a Bun WebSocket server on listenHost:listenPort.
 *   - client: connects to a remote host's connectUrl; skips all IM protocol
 *             connections regardless of what `protocols` says in the same
 *             config file.
 */
export type LanRelayInstanceRole = 'host' | 'client';

export interface LanRelayConfig {
  /** When false or omitted, LAN relay is disabled (default). */
  enabled?: boolean;
  /** host: run WebSocket server; client: connect to host, skip IM protocol connections. */
  instanceRole?: LanRelayInstanceRole;
  /** Shared secret for LAN peers (required when enabled). */
  token?: string;
  /** Host: bind address (default 0.0.0.0). */
  listenHost?: string;
  /** Host: WebSocket listen port (required for host when enabled). */
  listenPort?: number;
  /** Client: e.g. ws://192.168.1.10:47123/lan-relay */
  connectUrl?: string;
  /** Optional stable id shown in host logs (purely cosmetic). */
  clientId?: string;
  /**
   * Host only: when true, forward inbound IM messages (after EventRouter) to
   * all connected LAN clients as `inbound_message` envelopes. Required for
   * client instances to actually see real IM traffic; without this they only
   * receive whatever the host explicitly forwards via other channels.
   */
  relayInboundFromIm?: boolean;
}

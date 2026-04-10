// LAN relay / remote control configuration.
//
// Independent of both IM protocols (QQ/Discord/etc.) and Agent Cluster — the
// LAN relay is a separate transport that lets a "client" instance run the
// full bot stack without holding an IM session, by piggy-backing on a "host"
// instance that does.
//
// Phase 2 model: explicit dispatch + role-based service filter. The same
// config.d/ can be deployed on host and client; only the lanRelay block
// differs (instanceRole + endpoints + role-specific disabled lists).

import type { ProtocolName } from './protocol';

/**
 * Distinguishes the two LAN relay deployment modes:
 *   - host  : runs a Bun WebSocket server on listenHost:listenPort.
 *   - client: connects to a remote host's connectUrl; skips all IM protocol
 *             connections regardless of what `protocols` says in the same
 *             config file.
 */
export type LanRelayInstanceRole = 'host' | 'client';

/**
 * Role-scoped disable lists. The same config.d/ runs on host and client;
 * the right role's lists are applied at PluginInitializer / bootstrap time.
 *
 * disabledPlugins: plugin names that should NOT be instantiated in this role.
 *                  Filtering happens BEFORE PluginManager.loadPlugins so the
 *                  plugin code never runs (no DI side effects, no db opens).
 * disabledServices: service-config keys that should be skipped in bootstrap.
 *                  Currently used to skip zhihu/wechat data-collection
 *                  services on the client.
 */
export interface LanRelayRoleConfig {
  disabledPlugins?: string[];
  disabledServices?: string[];
}

/**
 * Default reply target — used when client-side business code calls
 * `runtime.sendToUser` but no dispatch origin is available (e.g. cron tasks).
 * The host falls back to this target.
 */
export interface LanRelayDefaultReplyTarget {
  protocol: ProtocolName;
  chatType: 'private' | 'group';
  userId?: string | number;
  groupId?: string | number;
}

export interface LanRelayConfig {
  /** When false or omitted, LAN relay is disabled (default). */
  enabled?: boolean;
  /** host: run WebSocket server; client: connect to host, skip IM protocol connections. */
  instanceRole?: LanRelayInstanceRole;
  /** Shared secret for LAN peers (required when enabled). */
  token?: string;

  // ── Host-side fields ─────────────────────────────────────────────────
  /** Host: bind address (default 0.0.0.0). */
  listenHost?: string;
  /** Host: WebSocket listen port (required for host when enabled). */
  listenPort?: number;
  /**
   * Host: fallback reply target used when a client calls `sendToUser` with
   * no dispatch origin available. Required for autonomous client tasks.
   */
  defaultReplyTarget?: LanRelayDefaultReplyTarget;

  // ── Client-side fields ───────────────────────────────────────────────
  /** Client: e.g. ws://192.168.1.10:47123/lan-relay */
  connectUrl?: string;
  /**
   * Client: stable id used for `/lan @<clientId>` dispatch addressing.
   * Required in client mode (Phase 2). Must be unique across connected
   * clients on the same host — duplicates are rejected at hello time.
   */
  clientId?: string;
  /** Client: optional human-readable label shown in `/lan list`. */
  clientLabel?: string;
  /**
   * Client: LAN-reachable address of THIS machine, used in `/lan list`.
   * Required in client mode. Pure config (no auto-detection) — D1 decision.
   */
  publicAddress?: string;

  // ── Role-scoped service/plugin filtering ─────────────────────────────
  /** Plugins/services to disable when running as host. */
  host?: LanRelayRoleConfig;
  /** Plugins/services to disable when running as client. */
  client?: LanRelayRoleConfig;
}

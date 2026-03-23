// Protocol Registry — per-protocol adapter references and metadata.
// Systems query this registry to get adapter capabilities instead of hardcoding protocol names.

import type { ProtocolAdapter } from './base/ProtocolAdapter';

interface ProtocolInfo {
  /** Bot's own user ID on this protocol (may differ from config.bot.selfId). */
  selfId?: string;
  adapter: ProtocolAdapter;
}

const registry = new Map<string, ProtocolInfo>();

// ── Registration ──

/**
 * Register a protocol's adapter and metadata.
 * Called by ProtocolAdapterInitializer when a protocol connects.
 */
export function registerProtocol(protocol: string, info: { selfId?: string; adapter: ProtocolAdapter }): void {
  registry.set(protocol, info);
}

/**
 * Unregister a protocol (e.g. on disconnect).
 */
export function unregisterProtocol(protocol: string): void {
  registry.delete(protocol);
}

// ── Queries ──

/** Get the bot self ID for a specific protocol (undefined → fall back to config.bot.selfId). */
export function getProtocolSelfId(protocol: string): string | undefined {
  return registry.get(protocol)?.selfId;
}

/** Get the adapter for a protocol. Throws if not registered. */
export function getProtocolAdapter(protocol: string): ProtocolAdapter {
  const info = registry.get(protocol);
  if (!info) {
    throw new Error(`Protocol "${protocol}" is not registered. Ensure the protocol is connected before sending.`);
  }
  return info.adapter;
}

/** Check if a protocol is registered. */
export function isProtocolRegistered(protocol: string): boolean {
  return registry.has(protocol);
}

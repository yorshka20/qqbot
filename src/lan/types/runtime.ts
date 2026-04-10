// Singleton LAN relay runtime accessor.
//
// Why a module-level singleton instead of DI: SendSystem is constructed deep
// in the conversation pipeline before initLanRelay() runs (initLanRelay needs
// the live MessageAPI + EventRouter from bootstrap). Routing through DI would
// force lazy resolution and add awareness of the LAN module to unrelated
// pipeline code. The singleton stays null when LAN relay is disabled, so
// code that checks `getLanRelayRuntime()?.isClientMode()` is no-cost in the
// default deployment.

import type { SendMessageResult } from '@/api/types';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';
import type { LanRelayOriginContext } from './wire';

/**
 * Parameters for a client-side outbound relay call. Mirrors the arguments
 * SendSystem would otherwise pass directly to MessageAPI on a host instance.
 */
export interface LanRelayOutboundParams {
  segments: MessageSegment[];
  /** Original inbound event used to derive the send target on the host side. */
  event: NormalizedMessageEvent;
  useForward: boolean;
  /** Required when useForward=true — bot's own QQ id for the forward node sender. */
  botSelfIdForForward?: number;
}

/**
 * Common interface implemented by both LanRelayHost and LanRelayClient.
 *
 * Phase 1 methods (SendSystem uses isClientMode + relayOutboundSend):
 *   - isClientMode / isHostMode / relayOutboundSend / stop
 *
 * Phase 2 additions (for client → host communication):
 *   - sendToUser    : ask host to deliver a message to the user via IM
 *   - reportToHost  : send an internal status line to host (no IM)
 *   - getCurrentOrigin : last dispatch origin (覆盖式)
 */
export interface ILanRelayRuntime {
  /** True when config has lanRelay.enabled + instanceRole client. */
  isClientMode(): boolean;
  /** True when config has lanRelay.enabled + instanceRole host. */
  isHostMode(): boolean;
  /** Client: send reply through host; throws if not connected or host rejects. */
  relayOutboundSend(params: LanRelayOutboundParams): Promise<SendMessageResult>;

  /**
   * Phase 2 — Client: ask host to deliver `segments` to the dispatch originator.
   * Uses the most recent origin context (from the last `dispatch_to_client`).
   * Falls back to sending to bot owner if no origin is available.
   */
  sendToUser(segments: MessageSegment[]): Promise<SendMessageResult>;

  /**
   * Phase 2 — Client: send an internal report to the host (no IM).
   * Host persists it to sqlite `lan_internal_reports` for `/lan log`.
   */
  reportToHost(level: 'debug' | 'info' | 'warn' | 'error', text: string): Promise<void>;

  /**
   * Phase 2 — Client: return the origin context from the most recent dispatch.
   * Null if no dispatch has been received yet.
   */
  getCurrentOrigin(): LanRelayOriginContext | null;

  stop(): Promise<void>;
}

/** Module-level slot — populated by initLanRelay(), nulled out on shutdown. */
let runtime: ILanRelayRuntime | null = null;

export function setLanRelayRuntime(r: ILanRelayRuntime | null): void {
  runtime = r;
}

export function getLanRelayRuntime(): ILanRelayRuntime | null {
  return runtime;
}

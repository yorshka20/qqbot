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
 * SendSystem only needs the role-check methods + relayOutboundSend, so the
 * interface stays narrow and the host's implementation of relayOutboundSend
 * just throws (it's never called on the host side).
 */
export interface ILanRelayRuntime {
  /** True when config has lanRelay.enabled + instanceRole client. */
  isClientMode(): boolean;
  /** True when config has lanRelay.enabled + instanceRole host. */
  isHostMode(): boolean;
  /** Client: send reply through host; throws if not connected or host rejects. */
  relayOutboundSend(params: LanRelayOutboundParams): Promise<SendMessageResult>;
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

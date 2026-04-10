// Public surface of the LAN relay module.
//
// Boundary contract: this module is intentionally independent of `src/cluster/`
// (Agent Cluster / ContextHub). It runs its own Bun.serve, defines its own
// config namespace (`lanRelay.*`), and is consumed by SendSystem only via the
// thin getLanRelayRuntime() singleton — no DI tokens, no shared HTTP routes.
// If Agent Cluster ever needs cross-machine LAN transport, it should call
// into this module rather than reimplementing a parallel WS server.

export type { LanRelayHandle } from './initLanRelay';
export { initLanRelay } from './initLanRelay';
export type { ILanRelayRuntime, LanRelayOutboundParams } from './runtime';
export { getLanRelayRuntime, setLanRelayRuntime } from './runtime';

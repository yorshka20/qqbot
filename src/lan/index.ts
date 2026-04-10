// Public surface of the LAN relay module.
//
// Boundary contract: this module is intentionally independent of `src/cluster/`
// (Agent Cluster / ContextHub). It runs its own Bun.serve, defines its own
// config namespace (`lanRelay.*`), and is consumed by SendSystem only via the
// thin getLanRelayRuntime() singleton — no DI tokens, no shared HTTP routes.
// If Agent Cluster ever needs cross-machine LAN transport, it should call
// into this module rather than reimplementing a parallel WS server.
//
// Folder layout:
//   ├── index.ts           — public exports (this file)
//   ├── init.ts            — initLanRelay entry point
//   ├── types/             — wire protocol + runtime interface
//   ├── host/              — LanRelayHost (Bun.serve WebSocket server)
//   └── client/            — LanRelayClient (auto-reconnecting WebSocket)

export type { LanRelayHandle } from './init';
export { initLanRelay } from './init';

export type { ILanRelayRuntime, LanRelayOutboundParams } from './types/runtime';
export { getLanRelayRuntime, setLanRelayRuntime } from './types/runtime';

export type {
  LanRelayActionPayload,
  LanRelayActionTarget,
  LanRelayDispatchPayload,
  LanRelayInternalReportPayload,
  LanRelayOriginContext,
  LanRelayRegisterPayload,
} from './types/wire';

export type { ClientEntry } from './host/registry';
export { LanRelayHost } from './host/LanRelayHost';
export { LanRelayClient, LAN_DISPATCH_PROTOCOL } from './client/LanRelayClient';

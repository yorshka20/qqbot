// Host-side client registry types.

/** Per-connection state attached to each upgraded WebSocket. */
export type ClientData = {
  /** True after the HTTP upgrade passed the token check. */
  authenticated: boolean;
  /** clientId from the hello envelope; used in close-time logs. */
  clientId?: string;
};

/** Entry in the host's client registry. */
export interface ClientEntry {
  ws: import('bun').ServerWebSocket<ClientData>;
  clientId: string;
  label?: string;
  lanAddress: string;
  startedAt: number;
  connectedAt: number;
  lastSeenAt: number;
  enabledPlugins?: string[];
}

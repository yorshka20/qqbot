// `/api/lan` — LAN relay host control plane.

/** `GET /api/lan/status`. Answers on a client instance too, with `role !== 'host'`. */
export interface LanStatusResponse {
  enabled: boolean;
  /** `null` when LAN relay is disabled or the runtime is not wired yet. */
  role: 'host' | 'client' | null;
  /** Only set in host mode. */
  listen: { host: string; port: number | null } | null;
  clientCount: number;
}

export interface LanClientSnapshot {
  clientId: string;
  label?: string;
  lanAddress: string;
  startedAt: number;
  connectedAt: number;
  lastSeenAt: number;
  enabledPlugins?: string[];
}

/** `GET /api/lan/clients` */
export interface LanClientsResponse {
  clients: LanClientSnapshot[];
}

export type LanReportLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LanReportRow {
  id: number;
  clientId: string;
  level: LanReportLevel;
  text: string;
  ts: number;
}

/** `GET /api/lan/clients/:id/reports` */
export interface LanReportsResponse {
  reports: LanReportRow[];
}

/** `POST /api/lan/clients/:id/dispatch` */
export interface LanDispatchResponse {
  dispatched: boolean;
}

/** `POST /api/lan/clients/:id/kick` */
export interface LanKickResponse {
  kicked: boolean;
}

// `data` payloads of the SSE events on `GET /api/lan/stream`. The SSE `event:` name
// carries which one it is, so no payload repeats it as a field.

export interface LanStreamInitData {
  clients: LanClientSnapshot[];
}

export type LanStreamClientConnectedData = LanClientSnapshot;

export interface LanStreamClientDisconnectedData {
  clientId: string;
}

export interface LanStreamInternalReportData {
  clientId: string;
  level: LanReportLevel;
  text: string;
  ts: number;
}

/** SSE `event:` name → its `data` payload. */
export interface LanStreamEventMap {
  init: LanStreamInitData;
  client_connected: LanStreamClientConnectedData;
  client_disconnected: LanStreamClientDisconnectedData;
  internal_report: LanStreamInternalReportData;
}

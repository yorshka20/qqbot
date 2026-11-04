import type { HubRoute } from '../cluster/hub/ContextHub';
import { jsonResponse } from './http';

/** `GET /health` — what the supervisor and the bot client read to tell the daemon is up. */
export interface ClusterDaemonHealthResponse {
  ok: boolean;
  startedAt: string;
  cluster: {
    running: boolean;
    paused: boolean;
    activeWorkers: number;
  };
}

export function healthRoute(snapshot: () => ClusterDaemonHealthResponse): HubRoute {
  return {
    prefix: '/health',
    handle(pathname, req) {
      if (pathname !== '/health') {
        return null;
      }
      if (req.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
      }
      return jsonResponse<ClusterDaemonHealthResponse>(snapshot());
    },
  };
}

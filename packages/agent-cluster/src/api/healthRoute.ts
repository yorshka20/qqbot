import type { ClusterDaemonHealthResponse } from '@qqbot/api-types';
import type { HubRoute } from '../cluster/hub/ContextHub';
import { jsonResponse } from './http';

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

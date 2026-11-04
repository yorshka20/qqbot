/**
 * ClusterDaemonProxyBackend — StaticServer backends that forward `/api/cluster/*` and
 * `/api/tickets/*` to the cluster daemon unchanged.
 *
 * The daemon serves both route families with the shapes in `@qqbot/api-types`, so the WebUI
 * keeps working against the bot's static server until it talks to the daemon directly. Requests
 * are forwarded with the daemon's bearer token and the response is returned as received,
 * body streaming, so `GET /api/cluster/stream` (SSE) passes through too.
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { type Backend, errorResponse, registerStaticBackend } from '@/services/staticServer/backend';
import type { ClusterClient } from './ClusterClient';

export class ClusterDaemonProxyBackend implements Backend {
  constructor(readonly prefix: string) {}

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const container = getContainer();
    if (!container.isRegistered(DITokens.CLUSTER_CLIENT)) {
      return errorResponse('Cluster daemon not configured (clusterClient)', 503);
    }
    const client = container.resolve<ClusterClient>(DITokens.CLUSTER_CLIENT);
    return client.proxy(req, `${pathname}${new URL(req.url).search}`);
  }
}

registerStaticBackend({ id: 'cluster', create: () => new ClusterDaemonProxyBackend('/api/cluster') });
registerStaticBackend({ id: 'tickets', create: () => new ClusterDaemonProxyBackend('/api/tickets') });

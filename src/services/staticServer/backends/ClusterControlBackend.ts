/**
 * ClusterControlBackend — WebUI control plane for Agent Cluster.
 *
 * Why this backend exists:
 * - ContextHub (and thus /api/cluster/*) is only available after the cluster is started.
 * - StaticServer is always available once the bot boots, so WebUI can start/stop the cluster from here.
 *
 * Routes:
 * - GET  /api/cluster-control/status
 * - POST /api/cluster-control/start
 * - POST /api/cluster-control/stop
 * - POST /api/cluster-control/pause
 * - POST /api/cluster-control/resume
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClusterManager } from '@/cluster/ClusterManager';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/cluster-control';

export class ClusterControlBackend {
  readonly prefix = API_PREFIX;

  private resolveClusterManager(): ClusterManager | null {
    try {
      return getContainer().resolve<ClusterManager>(DITokens.CLUSTER_MANAGER);
    } catch {
      return null;
    }
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    const subPath = pathname.slice(API_PREFIX.length);
    const cluster = this.resolveClusterManager();
    if (!cluster) {
      return errorResponse('Agent Cluster not configured (or requires SQLite)', 503);
    }

    if (req.method === 'GET' && (subPath === '/status' || subPath === '' || subPath === '/')) {
      return jsonResponse({
        started: cluster.isStarted(),
        status: cluster.getStatus(),
      });
    }

    if (req.method !== 'POST') {
      return errorResponse('Method not allowed', 405);
    }

    switch (subPath) {
      case '/start': {
        if (!cluster.isStarted()) {
          await cluster.start();
        }
        return jsonResponse({ started: true });
      }
      case '/stop': {
        if (cluster.isStarted()) {
          await cluster.stop();
        }
        return jsonResponse({ started: false });
      }
      case '/pause': {
        cluster.pause();
        return jsonResponse({ paused: true });
      }
      case '/resume': {
        cluster.resume();
        return jsonResponse({ paused: false });
      }
      default: {
        return errorResponse('Not found', 404);
      }
    }
  }
}


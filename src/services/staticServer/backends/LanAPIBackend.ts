/**
 * LanAPIBackend — REST + SSE for LAN relay clients.
 *
 * Mounted on StaticServer (always-on). Lets the host's WebUI inspect
 * connected LAN clients, browse their internal_report log, dispatch
 * commands, and force-disconnect them. Equivalent in scope to the
 * existing `/lan` QQ command (LanControlPlugin) but exposed over HTTP.
 *
 * Gating: every route requires the local instance to be running in
 * `host` mode (`getLanRelayRuntime()?.isHostMode() === true`). On a
 * client instance or a deployment with LAN relay disabled, every route
 * returns 503 — the client's own WebUI doesn't surface this page anyway,
 * but a friendly error beats a dangling 404 if someone curls the route.
 *
 * Routes:
 * - GET  /api/lan/status                    { enabled, role, listen, clientCount }
 * - GET  /api/lan/clients                   ClientSnapshot[]
 * - GET  /api/lan/clients/:id               ClientSnapshot | 404
 * - GET  /api/lan/clients/:id/reports?limit=&level=  internal_report rows
 * - GET  /api/lan/stream                    SSE: client_connected / disconnected / internal_report
 * - POST /api/lan/clients/:id/dispatch      body: { text }
 * - POST /api/lan/clients/:id/kick
 */

import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { LanHostSubscriber, LanRelayHost } from '@/lan/host/LanRelayHost';
import { getLanRelayRuntime } from '@/lan/types/runtime';
import { logger } from '@/utils/logger';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/lan';

export class LanAPIBackend {
  readonly prefix = API_PREFIX;

  /**
   * Resolve the LAN runtime as a host. Returns either the live host or a
   * 503 the caller pipes back. Pulled out so every route uses the exact
   * same gate and error message.
   */
  private requireHost(): LanRelayHost | Response {
    const runtime = getLanRelayRuntime();
    if (!runtime) {
      return errorResponse('LAN relay not enabled', 503);
    }
    if (!runtime.isHostMode()) {
      return errorResponse('LAN relay not in host mode', 503);
    }
    return runtime as LanRelayHost;
  }

  private resolveConfig(): Config | null {
    try {
      return getContainer().resolve<Config>(DITokens.CONFIG);
    } catch {
      return null;
    }
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const subPath = pathname.slice(API_PREFIX.length);

    if (req.method === 'GET') {
      return this.handleGet(subPath, req);
    }
    if (req.method === 'POST') {
      return this.handlePost(subPath, req);
    }
    return errorResponse('Method not allowed', 405);
  }

  private handleGet(subPath: string, req: Request): Response {
    const url = new URL(req.url);

    // /status — return whatever we know even on a non-host instance, so
    // the WebUI can render an informative "not in host mode" panel
    // instead of a hard 503.
    if (subPath === '' || subPath === '/' || subPath === '/status') {
      const runtime = getLanRelayRuntime();
      const config = this.resolveConfig();
      const lr = config?.getLanRelayConfig();
      return jsonResponse({
        enabled: !!lr?.enabled,
        role: runtime ? (runtime.isHostMode() ? 'host' : 'client') : null,
        listen:
          lr?.instanceRole === 'host'
            ? { host: lr.listenHost ?? '0.0.0.0', port: lr.listenPort ?? null }
            : null,
        clientCount: runtime?.isHostMode() ? (runtime as LanRelayHost).listClients().length : 0,
      });
    }

    // Everything below requires host mode.
    const gated = this.requireHost();
    if (gated instanceof Response) return gated;
    const host = gated;

    if (subPath === '/clients') {
      return jsonResponse({ clients: host.listClientSnapshots() });
    }

    if (subPath === '/stream') {
      return this.handleSSEStream(host);
    }

    // /clients/:id
    const clientMatch = subPath.match(/^\/clients\/([^/]+)$/);
    if (clientMatch) {
      const snap = host.getClientSnapshot(clientMatch[1]);
      if (!snap) return errorResponse('Client not connected', 404);
      return jsonResponse(snap);
    }

    // /clients/:id/reports
    const reportsMatch = subPath.match(/^\/clients\/([^/]+)\/reports$/);
    if (reportsMatch) {
      if (!host.hasReportStore()) {
        return errorResponse('Host has no sqlite-backed report store', 503);
      }
      const limitRaw = url.searchParams.get('limit');
      const levelRaw = url.searchParams.get('level');
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      const level =
        levelRaw === 'debug' || levelRaw === 'info' || levelRaw === 'warn' || levelRaw === 'error'
          ? levelRaw
          : undefined;
      const rows = host.getReports(reportsMatch[1], { limit, level });
      return jsonResponse({ reports: rows });
    }

    return errorResponse('Not found', 404);
  }

  private async handlePost(subPath: string, req: Request): Promise<Response> {
    const gated = this.requireHost();
    if (gated instanceof Response) return gated;
    const host = gated;

    // /clients/:id/dispatch
    const dispatchMatch = subPath.match(/^\/clients\/([^/]+)\/dispatch$/);
    if (dispatchMatch) {
      let body: { text?: string };
      try {
        body = (await req.json()) as { text?: string };
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const text = body.text?.trim();
      if (!text) {
        return errorResponse('Missing required field: text', 400);
      }

      // Synthesize a return-path origin pointing at the bot owner so any
      // sendToUser() reply on the client lands as a private message to
      // owner. Mirrors what ClusterEscalation already does for hub_ask.
      const config = this.resolveConfig();
      if (!config) {
        return errorResponse('Config not available', 500);
      }
      const ownerId = config.getConfig().bot?.owner;
      const enabledProtocols = config.getEnabledProtocols();
      const preferredProtocol = enabledProtocols[0]?.name;
      if (!ownerId || !preferredProtocol) {
        return errorResponse(
          `Cannot dispatch from WebUI — bot.owner=${ownerId || 'missing'} preferredProtocol=${preferredProtocol || 'missing'}`,
          500,
        );
      }

      const ok = host.dispatchFromWebUI(dispatchMatch[1], text, {
        ownerUserId: ownerId,
        protocol: preferredProtocol,
      });
      if (!ok) {
        return errorResponse('Client not connected', 404);
      }
      return jsonResponse({ dispatched: true });
    }

    // /clients/:id/kick
    const kickMatch = subPath.match(/^\/clients\/([^/]+)\/kick$/);
    if (kickMatch) {
      const ok = host.kickClient(kickMatch[1]);
      if (!ok) {
        return errorResponse('Client not connected', 404);
      }
      return jsonResponse({ kicked: true });
    }

    return errorResponse('Not found', 404);
  }

  /**
   * Open an SSE stream against the LAN host. Pushes one `init` event with
   * the current client list, then forwards `client_connected`,
   * `client_disconnected`, and `internal_report` as the host emits them.
   *
   * The subscriber owns its own teardown — when the consumer disconnects,
   * the next `controller.enqueue()` throws, the host's `emit()` catches
   * the exception and removes the subscriber. No explicit cancel hook
   * needed (and Bun's `ReadableStream.cancel` doesn't fire reliably for
   * SSE consumers anyway).
   */
  private handleSSEStream(host: LanRelayHost): Response {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch (err) {
            // Stream closed by consumer; the host's emit() will catch on
            // its next attempt and unregister us, so just flip the flag.
            closed = true;
            logger.debug('[LanAPIBackend] SSE consumer dropped:', err);
          }
        };

        const subscriber: LanHostSubscriber = {
          send,
          close: () => {
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
          },
        };

        host.addSubscriber(subscriber);

        // Initial snapshot so the consumer doesn't have to GET /clients
        // separately on connect.
        send('init', { clients: host.listClientSnapshots() });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

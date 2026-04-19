/**
 * Avatar Preview Server — serves a static preview page over HTTP and streams
 * Live2D parameter/status updates over WebSocket on the same Bun server.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from 'bun';
import { logger } from '../utils/logger';
import type { PreviewClientMessage, PreviewConfig, PreviewFrame, PreviewMessage, PreviewStatus } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CONFIG: PreviewConfig = {
  port: 8002,
  host: '0.0.0.0',
};

export interface PreviewServerHandlers {
  onTrigger?: (data: { action: string; emotion?: string; intensity?: number }) => void;
  /**
   * Called after every WS client open/close with the new total client count.
   * Lets callers gate expensive downstream work (frame computation, layer
   * sampling) on the presence of actual consumers.
   */
  onClientCountChange?: (count: number) => void;
}

export class PreviewServer {
  private readonly config: PreviewConfig;
  private readonly handlers: PreviewServerHandlers;
  private server: ReturnType<typeof serve> | null = null;
  private clients = new Set<import('bun').ServerWebSocket<unknown>>();
  private latestStatus: PreviewStatus | null = null;

  constructor(config?: Partial<PreviewConfig>, handlers: PreviewServerHandlers = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const { port, host } = this.config;
    const clients = this.clients;
    const server = this;

    this.server = serve({
      port,
      hostname: host,
      idleTimeout: 255,
      fetch(req, srv) {
        // Try WebSocket upgrade first — upgrade requests hit "/" too, so
        // pathname routing would otherwise shadow them with the HTML response.
        if (srv.upgrade(req, { data: undefined })) {
          return undefined;
        }

        const url = new URL(req.url);

        if (url.pathname === '/') {
          const htmlPath = join(__dirname, 'client', 'index.html');
          const html = readFileSync(htmlPath, 'utf-8');
          return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ status: 'ok', clients: clients.size }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          clients.add(ws);
          server.handlers.onClientCountChange?.(clients.size);
          // Send latest cached status to new client
          if (server.latestStatus !== null) {
            const msg: PreviewMessage = { type: 'status', data: server.latestStatus };
            ws.send(JSON.stringify(msg));
          }
        },
        message(_ws, message) {
          // Expect only string messages containing a JSON object with type:'trigger'
          const rawMessage = typeof message === 'string' ? message : Buffer.from(message).toString('utf-8');
          let msg: PreviewClientMessage;
          try {
            msg = JSON.parse(rawMessage) as PreviewClientMessage;
          } catch {
            // JSON parse failure — silent drop
            return;
          }

          if (msg.type !== 'trigger') return;
          if (!msg.data) return;
          if (typeof msg.data.action !== 'string' || msg.data.action === '') return;

          const data = msg.data;
          const sanitized: { action: string; emotion?: string; intensity?: number } = {
            action: data.action,
          };
          if (typeof data.emotion === 'string') {
            sanitized.emotion = data.emotion;
          }
          if (typeof data.intensity === 'number' && Number.isFinite(data.intensity)) {
            sanitized.intensity = data.intensity;
          }

          server.handlers.onTrigger?.(sanitized);
          logger.debug('[PreviewServer] Trigger received', {
            action: sanitized.action,
            emotion: sanitized.emotion,
            intensity: sanitized.intensity,
          });
        },
        close(ws) {
          clients.delete(ws);
          server.handlers.onClientCountChange?.(clients.size);
        },
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.server.stop();
    this.server = null;
  }

  broadcastFrame(frame: PreviewFrame): void {
    const msg: PreviewMessage = { type: 'frame', data: frame };
    const text = JSON.stringify(msg);
    for (const client of this.clients) {
      try {
        client.send(text);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  updateStatus(status: PreviewStatus): void {
    this.latestStatus = status;
    const msg: PreviewMessage = { type: 'status', data: status };
    const text = JSON.stringify(msg);
    for (const client of this.clients) {
      try {
        client.send(text);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

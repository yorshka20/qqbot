/**
 * Avatar Preview Server — serves a static preview page over HTTP and streams
 * Live2D parameter/status updates over WebSocket on the same Bun server.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from 'bun';
import type { PreviewConfig, PreviewFrame, PreviewMessage, PreviewStatus } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CONFIG: PreviewConfig = {
  port: 8002,
  host: '0.0.0.0',
};

export class PreviewServer {
  private readonly config: PreviewConfig;
  private server: ReturnType<typeof serve> | null = null;
  private clients = new Set<import('bun').ServerWebSocket<unknown>>();
  private latestStatus: PreviewStatus | null = null;

  constructor(config?: Partial<PreviewConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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

        // WebSocket upgrade
        const upgraded = srv.upgrade(req, { data: undefined });
        if (upgraded) {
          return undefined;
        }
        return new Response('Upgrade failed', { status: 500 });
      },
      websocket: {
        open(ws) {
          clients.add(ws);
          // Send latest cached status to new client
          if (server.latestStatus !== null) {
            const msg: PreviewMessage = { type: 'status', data: server.latestStatus };
            ws.send(JSON.stringify(msg));
          }
        },
        message(_ws, _message) {
          // Client messages are not expected in this server; ignore them.
        },
        close(ws) {
          clients.delete(ws);
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

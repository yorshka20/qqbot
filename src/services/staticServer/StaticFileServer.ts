/**
 * Static file server with prefix-based routing.
 *
 * Backends are registered via the Backend interface — each provides a prefix
 * and a handle() method. See backends/index.ts for the registry.
 */

import { resolve } from 'node:path';
import { serve } from 'bun';
import type { StaticServerConfig } from '@/core/config/types/bot';
import { logger } from '@/utils/logger';
import { type Backend, createBackends } from './backends';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type StaticFileServerInstance = {
  getBaseURL(): string;
  getFileURL(relativePath: string): string;
  stop(): void;
};

// ────────────────────────────────────────────────────────────────────────────
// CORS
// ────────────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    h.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ────────────────────────────────────────────────────────────────────────────
// StaticFileServer
// ────────────────────────────────────────────────────────────────────────────

export class StaticFileServer implements StaticFileServerInstance {
  private port: number;
  private readonly baseDir: string;
  private readonly hostIP?: string;
  private server: ReturnType<typeof serve> | null = null;
  private baseURL = '';

  private readonly backends: Backend[];

  constructor(config: StaticServerConfig) {
    this.port = config.port;
    this.baseDir = resolve(config.root);
    this.hostIP = config.host;
    this.backends = createBackends(this.baseDir);
  }

  // ──────────────────────────────────────────────────
  // Request handling
  // ──────────────────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    for (const backend of this.backends) {
      // Strict prefix match: the next char must be '/' or end-of-string.
      // A loose startsWith would let a backend with prefix "/api/cluster"
      // shadow another with prefix "/api/cluster-control", because dispatch
      // order is list order and the first match wins.
      if (pathname !== backend.prefix && !pathname.startsWith(`${backend.prefix}/`)) {
        continue;
      }

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return corsPreflightResponse();
      }

      const response = await backend.handle(pathname, req);
      if (response !== null) {
        return withCors(response);
      }
    }

    return withCors(new Response('Not Found', { status: 404 }));
  }

  // ──────────────────────────────────────────────────
  // Server lifecycle
  // ──────────────────────────────────────────────────

  async start(): Promise<string> {
    if (this.server) {
      return this.baseURL;
    }

    const maxAttempts = 10;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tryPort = this.port + attempt;

      try {
        this.server = serve({
          port: tryPort,
          hostname: '0.0.0.0',
          fetch: (req) => this.handleRequest(req),
        });

        this.port = tryPort;
        this.baseURL = `http://${this.hostIP ?? 'localhost'}:${this.port}`;

        if (attempt > 0) {
          logger.info(`[StaticFileServer] Port ${this.port - attempt} was in use, using ${tryPort} instead`);
        }

        this.logStartup();
        return this.baseURL;
      } catch (error) {
        lastError = error;
        const msg = String(error);
        if (!msg.includes('in use') && !msg.includes('EADDRINUSE')) {
          logger.error(`[StaticFileServer] Failed to start: ${error}`);
          throw error;
        }
      }
    }

    logger.error(`[StaticFileServer] Failed to start after ${maxAttempts} attempts: ${lastError}`);
    throw lastError;
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      logger.info('[StaticFileServer] Stopped');
    }
  }

  // ──────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────

  getBaseURL(): string {
    return this.baseURL;
  }

  getFileURL(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    return `${this.baseURL}/output/${normalized}`;
  }

  // ──────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────

  private logStartup(): void {
    const prefixes = this.backends.map((b) => b.prefix).join(', ');
    logger.info(`[StaticFileServer] Started on ${this.baseURL}`);
    logger.debug(`[StaticFileServer] Routes: ${prefixes}`);
  }
}

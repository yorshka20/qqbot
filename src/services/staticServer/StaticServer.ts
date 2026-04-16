/**
 * **StaticServer** — single local HTTP service (`Bun.serve`) that mounts every
 * WebUI/backend route: REST APIs (cluster, tickets, reports, …) and optional
 * static file routes.
 *
 * This is **not** the same as narrow “static file” routes only: serving bytes
 * from disk is the `files` and `output` backend modules (`FileManagerBackend`,
 * `OutputStaticHost`). Omit them per-role via `lanRelay.*.disabledStaticBackends` in config.
 */

import { resolve } from 'node:path';
import { serve } from 'bun';
import type { StaticServerConfig } from '@/core/config/types/bot';
import { logger } from '@/utils/logger';
import { type Backend, createBackends } from './backends';

export interface StaticServerInitOptions {
  /** Backend module ids to exclude — must match `lanRelay.*.disabledStaticBackends` / `createBackends` registry. */
  disabledBackendIds?: string[];
  /**
   * Absolute path to the tickets storage directory (see `TicketsConfig`).
   * Forwarded to `TicketBackend`. Required when the `tickets` backend is
   * enabled — bootstrap resolves this from `Config.getTicketsDir()`.
   */
  ticketsDir?: string;
}

export type StaticServerInstance = {
  getBaseURL(): string;
  stop(): void;
};

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

export class StaticServer implements StaticServerInstance {
  private port: number;
  private readonly baseDir: string;
  private readonly hostIP?: string;
  private server: ReturnType<typeof serve> | null = null;
  private baseURL = '';

  private readonly backends: Backend[];

  constructor(config: StaticServerConfig, options?: StaticServerInitOptions) {
    this.port = config.port;
    this.baseDir = resolve(config.root);
    this.hostIP = config.host;
    const disabled = new Set(options?.disabledBackendIds ?? []);
    this.backends = createBackends(this.baseDir, {
      disabledIds: disabled,
      ticketsDir: options?.ticketsDir,
    });
    if (disabled.size > 0) {
      logger.info(`[StaticServer] Excluded backend module(s): ${[...disabled].sort().join(', ')}`);
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    for (const backend of this.backends) {
      if (pathname !== backend.prefix && !pathname.startsWith(`${backend.prefix}/`)) {
        continue;
      }

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
          // Match ContextHub: long-lived requests (SSE, slow cluster APIs) must
          // not hit Bun's default 10s idle timeout.
          idleTimeout: 255,
          fetch: (req) => this.handleRequest(req),
        });

        this.port = tryPort;
        this.baseURL = `http://${this.hostIP ?? 'localhost'}:${this.port}`;

        if (attempt > 0) {
          logger.info(`[StaticServer] Port ${this.port - attempt} was in use, using ${tryPort} instead`);
        }

        this.logStartup();
        return this.baseURL;
      } catch (error) {
        lastError = error;
        const msg = String(error);
        if (!msg.includes('in use') && !msg.includes('EADDRINUSE')) {
          logger.error(`[StaticServer] Failed to start: ${error}`);
          throw error;
        }
      }
    }

    logger.error(`[StaticServer] Failed to start after ${maxAttempts} attempts: ${lastError}`);
    throw lastError;
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      logger.info('[StaticServer] Stopped');
    }
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  private logStartup(): void {
    const prefixes = this.backends.map((b) => b.prefix).join(', ');
    logger.info(`[StaticServer] Started on ${this.baseURL}`);
    logger.debug(`[StaticServer] Routes: ${prefixes}`);
  }
}

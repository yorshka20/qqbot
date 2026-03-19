/**
 * Static file server with clear routing structure.
 *
 * Routes:
 * - /api/files/*    → FileManagerBackend (file operations)
 * - /api/reports/*  → ReportBackend (report API)
 * - /output/*       → OutputStaticHost (static file serving)
 */

import { resolve } from 'node:path';
import { serve } from 'bun';
import type { StaticServerConfig } from '@/core/config/types/bot';
import { logger } from '@/utils/logger';
import { FileManagerBackend } from './FileManagerBackend';
import { InsightsBackend } from './InsightsBackend';
import { MomentsBackend } from './MomentsBackend';
import { OutputStaticHost } from './OutputStaticHost';
import { ReportBackend } from './ReportBackend';
import { ZhihuBackend } from './ZhihuBackend';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type StaticFileServerInstance = {
  getBaseURL(): string;
  getFileURL(relativePath: string): string;
  stop(): void;
};

/** Route handler that returns Response or null if not matched */
type RouteHandler = (req: Request, url: URL) => Promise<Response | null> | Response | null;

/** Route definition with prefix matching */
interface Route {
  prefix: string;
  handler: RouteHandler;
  corsEnabled?: boolean;
}

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

  // Backends
  private readonly fileManager: FileManagerBackend;
  private readonly reportBackend: ReportBackend;
  private readonly insightsBackend: InsightsBackend;
  private readonly momentsBackend: MomentsBackend;
  private readonly zhihuBackend: ZhihuBackend;
  private readonly outputHost: OutputStaticHost;

  // Routes (evaluated in order)
  private readonly routes: Route[];

  constructor(config: StaticServerConfig) {
    this.port = config.port;
    this.baseDir = resolve(config.root);
    this.hostIP = config.host;

    // Initialize backends
    this.fileManager = new FileManagerBackend(this.baseDir);
    this.reportBackend = new ReportBackend();
    this.insightsBackend = new InsightsBackend();
    this.momentsBackend = new MomentsBackend();
    this.zhihuBackend = new ZhihuBackend();
    this.outputHost = new OutputStaticHost(this.baseDir);

    // Define routes (order matters: more specific prefixes first)
    this.routes = [
      {
        prefix: '/api/files',
        handler: (req, url) => this.fileManager.handle(url.pathname, req),
        corsEnabled: true,
      },
      {
        prefix: '/api/reports',
        handler: (req, url) => this.reportBackend.handle(url.pathname, req),
        corsEnabled: true,
      },
      {
        prefix: '/api/insights',
        handler: (req, url) => this.insightsBackend.handle(url.pathname, req),
        corsEnabled: true,
      },
      {
        prefix: '/api/moments',
        handler: (req, url) => this.momentsBackend.handle(url.pathname, req),
        corsEnabled: true,
      },
      {
        prefix: '/api/zhihu',
        handler: (req, url) => this.zhihuBackend.handle(url.pathname, req),
        corsEnabled: true,
      },
      {
        prefix: '/output',
        handler: (req, url) => this.outputHost.handle(url.pathname, req),
        corsEnabled: true,
      },
    ];
  }

  // ──────────────────────────────────────────────────
  // Request handling
  // ──────────────────────────────────────────────────

  /**
   * Main request handler - matches routes and dispatches to backends.
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // Find matching route
    for (const route of this.routes) {
      if (!pathname.startsWith(route.prefix)) continue;

      // Handle CORS preflight
      if (req.method === 'OPTIONS' && route.corsEnabled) {
        return corsPreflightResponse();
      }

      // Dispatch to handler
      const response = await route.handler(req, url);
      if (response !== null) {
        return route.corsEnabled ? withCors(response) : response;
      }
    }

    // No route matched
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

  /**
   * Get public URL for a file under the output directory.
   */
  getFileURL(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    return `${this.baseURL}/output/${normalized}`;
  }

  // ──────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────

  private logStartup(): void {
    const routeInfo = this.routes.map((r) => r.prefix).join(', ');
    logger.info(`[StaticFileServer] Started on ${this.baseURL}`);
    logger.debug(`[StaticFileServer] Routes: ${routeInfo}`);
  }
}

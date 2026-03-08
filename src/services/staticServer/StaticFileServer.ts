/**
 * Static file server: composes OutputStaticHost (pure /output/ hosting) and
 * FileManagerBackend (API only). UI runs on dev server.
 */

import { serve } from 'bun';
import { resolve } from 'path';
import type { StaticServerConfig } from '@/core/config/types/bot';
import { logger } from '@/utils/logger';
import { FileManagerBackend } from './FileManagerBackend';
import { OutputStaticHost } from './OutputStaticHost';

export type StaticFileServerInstance = {
  getBaseURL(): string;
  getFileURL(relativePath: string): string;
  stop(): void;
};

export class StaticFileServer implements StaticFileServerInstance {
  private port: number;
  private baseDir: string;
  private hostIP?: string;
  private server: ReturnType<typeof serve> | null = null;
  private baseURL = '';

  private readonly outputHost: OutputStaticHost;
  private readonly fileManagerBackend: FileManagerBackend;

  constructor(config: StaticServerConfig) {
    this.port = config.port;
    this.baseDir = resolve(config.root);
    this.hostIP = config.host;
    this.outputHost = new OutputStaticHost(this.baseDir);
    this.fileManagerBackend = new FileManagerBackend(this.baseDir);
  }

  async start(): Promise<string> {
    if (this.server) {
      return this.baseURL;
    }

    const maxAttempts = 10;
    const fetchHandler = async (req: Request) => {
      const pathname = new URL(req.url).pathname;

      // 1. File manager (API + SPA) — frontend backend
      const backendResponse = await this.fileManagerBackend.handle(pathname, req);
      if (backendResponse !== null) {
        return backendResponse;
      }

      // 2. Pure static file hosting — /output/*
      const hostResponse = await this.outputHost.handle(pathname, req);
      if (hostResponse !== null) {
        return hostResponse;
      }

      return new Response('Not Found', { status: 404 });
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tryPort = this.port + attempt;
      try {
        this.server = serve({
          port: tryPort,
          hostname: '0.0.0.0',
          fetch: fetchHandler,
        });
        this.port = tryPort;
        this.baseURL = `http://${this.hostIP ?? 'localhost'}:${this.port}`;
        if (attempt > 0) {
          logger.info(`[StaticFileServer] Port ${this.port - attempt} was in use, using ${tryPort} instead`);
        }
        logger.info(`[StaticFileServer] Started on ${this.baseURL} (API at /api/files; use dev server for UI)`);
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

    logger.error(`[StaticFileServer] Failed to start: ${lastError}`);
    throw lastError;
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      logger.info('[StaticFileServer] Stopped');
    }
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Public URL for a file under the output directory (used by ImageGenerationService etc.).
   */
  getFileURL(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    return `${this.baseURL}/output/${normalized}`;
  }
}

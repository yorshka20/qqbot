// Simple static file server for serving generated images
import { logger } from '@/utils/logger';
import { serve } from 'bun';
import { readFile } from 'fs/promises';
import { extname } from 'path';

export class StaticFileServer {
  private port: number;
  private baseDir: string;
  private server: ReturnType<typeof serve> | null = null;
  private baseURL: string;
  private hostIP?: string;

  constructor(port: number = 8888, baseDir: string = './output', hostIP?: string) {
    this.port = port;
    this.baseDir = baseDir;
    this.hostIP = hostIP;
    this.baseURL = '';
  }

  /**
   * Start the static file server
   */
  start(): string {
    if (this.server) {
      return this.baseURL;
    }

    const baseDir = this.baseDir;

    try {
      this.server = serve({
        port: this.port,
        hostname: '0.0.0.0', // Listen on all interfaces (allows external access)
        async fetch(req) {
          const url = new URL(req.url);
          const pathname = url.pathname;

          // Only serve files from /output/ path
          if (!pathname.startsWith('/output/')) {
            return new Response('Not Found', { status: 404 });
          }

          try {
            // Remove /output/ prefix and get relative path
            const relativePath = pathname.slice('/output/'.length);
            const filePath = `${baseDir}/${relativePath}`;

            // Read file
            const fileBuffer = await readFile(filePath);

            // Determine content type based on extension
            const ext = extname(filePath).toLowerCase();
            const contentType =
              {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
              }[ext] || 'application/octet-stream';

            return new Response(fileBuffer, {
              headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600',
              },
            });
          } catch (error) {
            logger.error(`[StaticFileServer] Error serving file: ${error}`);
            return new Response('File not found', { status: 404 });
          }
        },
      });

      // Determine base URL
      this.baseURL = `http://${this.hostIP}:${this.port}`;

      logger.info(`[StaticFileServer] Started on ${this.baseURL}`);
      return this.baseURL;
    } catch (error) {
      logger.error(`[StaticFileServer] Failed to start: ${error}`);
      throw error;
    }
  }

  /**
   * Stop the static file server
   */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      logger.info('[StaticFileServer] Stopped');
    }
  }

  /**
   * Get the base URL for accessing files
   */
  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Convert a relative path (from output directory) to a public URL
   * @param relativePath - Relative path from output directory (e.g., 'novelai/image.png')
   */
  getFileURL(relativePath: string): string {
    // Normalize path separators and construct URL
    const normalized = relativePath.replace(/\\/g, '/');
    return `${this.baseURL}/output/${normalized}`;
  }
}

// Singleton instance
let serverInstance: StaticFileServer | null = null;

/**
 * Initialize and start the static file server (should be called once at startup)
 * @param port Port number (default: 8888)
 * @param baseDir Base directory for serving files (default: './output')
 * @param hostIP Host IP address to bind to (optional, auto-detect if not provided)
 */
export function initStaticFileServer(port?: number, baseDir?: string, hostIP?: string): StaticFileServer {
  if (serverInstance) {
    return serverInstance;
  }

  serverInstance = new StaticFileServer(port, baseDir, hostIP);
  serverInstance.start();

  return serverInstance;
}

/**
 * Get the static file server instance (must be initialized first)
 */
export function getStaticFileServer(): StaticFileServer {
  if (!serverInstance) {
    throw new Error('Static file server not initialized. Call initStaticFileServer() first.');
  }
  return serverInstance;
}

/**
 * Stop the static file server
 */
export function stopStaticFileServer(): void {
  if (serverInstance) {
    serverInstance.stop();
    serverInstance = null;
  }
}

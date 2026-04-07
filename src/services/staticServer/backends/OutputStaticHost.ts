/**
 * Pure static file hosting for the output directory.
 * Serves only GET /output/* with path traversal protection.
 * Used by ImageGenerationService and other consumers of getFileURL().
 *
 * Caching strategy:
 *  - ETag (weak, based on mtime + size) for conditional requests (304 Not Modified)
 *  - Cache-Control: public, max-age=86400, immutable for long-lived browser caching
 *  - Content-Length for efficient connection reuse
 */

import { stat } from 'fs/promises';
import { extname, resolve } from 'path';
import { logger } from '@/utils/logger';
import { resolveSafe } from './pathSafety';
import type { Backend } from './types';

const OUTPUT_PREFIX = '/output/';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

export class OutputStaticHost implements Backend {
  readonly prefix = '/output';
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  /**
   * Handle request if it is for /output/*. Returns null if path is not under /output/.
   */
  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(OUTPUT_PREFIX)) {
      return null;
    }

    let relativePath: string;
    try {
      relativePath = decodeURIComponent(pathname.slice(OUTPUT_PREFIX.length));
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const filePath = resolveSafe(this.baseDir, relativePath);
    if (filePath === null) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return new Response('Not found', { status: 404 });
      }

      // Build weak ETag from mtime + size (sufficient for static output files)
      const etag = `W/"${fileStat.mtimeMs.toString(36)}-${fileStat.size.toString(36)}"`;

      // Check conditional request — return 304 if client already has this version
      const ifNoneMatch = req.headers.get('if-none-match');
      if (ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      const ext = extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

      // Use Bun.file() for efficient zero-copy file serving
      return new Response(Bun.file(filePath), {
        headers: {
          'Content-Type': contentType,
          'Content-Length': fileStat.size.toString(),
          ETag: etag,
          'Cache-Control': 'public, max-age=86400',
          'Last-Modified': fileStat.mtime.toUTCString(),
        },
      });
    } catch (error) {
      logger.error(`[OutputStaticHost] Error serving file: ${error}`);
      return new Response('File not found', { status: 404 });
    }
  }
}

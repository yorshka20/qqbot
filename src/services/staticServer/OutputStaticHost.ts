/**
 * Pure static file hosting for the output directory.
 * Serves only GET /output/* with path traversal protection.
 * Used by ImageGenerationService and other consumers of getFileURL().
 */

import { readFile } from 'fs/promises';
import { extname, resolve } from 'path';
import { logger } from '@/utils/logger';
import { resolveSafe } from './pathSafety';

const OUTPUT_PREFIX = '/output/';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export class OutputStaticHost {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  /**
   * Handle request if it is for /output/*. Returns null if path is not under /output/.
   */
  async handle(pathname: string, _req: Request): Promise<Response | null> {
    if (!pathname.startsWith(OUTPUT_PREFIX)) {
      return null;
    }

    const relativePath = pathname.slice(OUTPUT_PREFIX.length);
    const filePath = resolveSafe(this.baseDir, relativePath);
    if (filePath === null) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const fileBuffer = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

      return new Response(fileBuffer, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      logger.error(`[OutputStaticHost] Error serving file: ${error}`);
      return new Response('File not found', { status: 404 });
    }
  }
}

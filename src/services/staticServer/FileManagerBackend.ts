/**
 * File manager backend: REST API (/api/files) only.
 * UI runs on dev server (bun run dev); this server does not serve the frontend.
 */

import { readdir, rename, rmdir, stat, unlink } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { logger } from '@/utils/logger';
import { resolveSafe } from './pathSafety';

const API_PREFIX = '/api/files';

function jsonResponse(obj: object, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class FileManagerBackend {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  /**
   * Handle request if it is for /api/files. Returns null otherwise.
   */
  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (pathname.startsWith(API_PREFIX)) {
      return this.handleApi(pathname, req);
    }
    return null;
  }

  private async handleApi(pathname: string, req: Request): Promise<Response> {
    if (pathname === `${API_PREFIX}/list` && req.method === 'GET') {
      const raw = new URL(req.url).searchParams.get('path') ?? '';
      const dirPath = resolveSafe(this.baseDir, raw);
      if (dirPath === null) {
        return jsonResponse({ error: 'Invalid path' }, 400);
      }
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const items = await Promise.all(
          entries.map(async (e) => {
            const full = join(dirPath, e.name);
            const rel = relative(this.baseDir, full).replace(/\\/g, '/');
            const st = await stat(full);
            return {
              name: e.name,
              path: rel,
              isDir: e.isDirectory(),
              size: st.isFile() ? st.size : undefined,
              mtime: st.mtimeMs,
            };
          }),
        );
        return jsonResponse({ items });
      } catch (err) {
        logger.error(`[FileManagerBackend] list error: ${err}`);
        return jsonResponse({ error: 'Failed to list directory' }, 500);
      }
    }

    if (pathname === API_PREFIX && req.method === 'DELETE') {
      const raw = new URL(req.url).searchParams.get('path') ?? '';
      const target = resolveSafe(this.baseDir, raw);
      if (target === null) {
        return jsonResponse({ error: 'Invalid path' }, 400);
      }
      if (target === this.baseDir) {
        return jsonResponse({ error: 'Cannot delete root' }, 400);
      }
      try {
        const st = await stat(target);
        if (st.isDirectory()) {
          await rmdir(target);
        } else {
          await unlink(target);
        }
        return jsonResponse({ ok: true });
      } catch (err) {
        logger.error(`[FileManagerBackend] delete error: ${err}`);
        return jsonResponse({ error: 'Failed to delete' }, 500);
      }
    }

    if (pathname === `${API_PREFIX}/move` && req.method === 'POST') {
      let body: { from?: string; to?: string };
      try {
        body = (await req.json()) as { from?: string; to?: string };
      } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400);
      }
      const fromPath = body.from ?? '';
      const toPath = body.to ?? '';
      const fromFull = resolveSafe(this.baseDir, fromPath);
      const toFull = resolveSafe(this.baseDir, toPath);
      if (fromFull === null || toFull === null) {
        return jsonResponse({ error: 'Invalid path' }, 400);
      }
      if (fromFull === this.baseDir) {
        return jsonResponse({ error: 'Cannot move root' }, 400);
      }
      try {
        await rename(fromFull, toFull);
        return jsonResponse({ ok: true });
      } catch (err) {
        logger.error(`[FileManagerBackend] move error: ${err}`);
        return jsonResponse({ error: 'Failed to move' }, 500);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
}

/**
 * Read-only docs preview API: browse and fetch local markdown/text under fixed roots.
 *
 * Routes:
 * - GET /api/docs/roots  -> { roots: DocsRootInfo[] }
 * - GET /api/docs/list?root=&path=  -> { items: FileItem[] } (paths relative to that root)
 * - GET /api/docs/raw?root=&path=   -> file bytes (path must be a file)
 *
 * Roots:
 * - docs: <repo>/docs
 * - claude-learnings: ~/.claude/learnings
 * - claude-workbook: ~/.claude/workbook
 */

import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import type { FileItem } from './FileManagerBackend';
import { resolveSafe } from './pathSafety';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/docs';
const MAX_RAW_BYTES = 15 * 1024 * 1024;

export interface DocsRootInfo {
  id: string;
  label: string;
  /** Absolute path on disk (for display / debugging). */
  absPath: string;
  exists: boolean;
}

interface RootsResponse {
  roots: DocsRootInfo[];
}

interface ListResponse {
  items: FileItem[];
}

function buildRootMap(): Map<string, { label: string; absPath: string }> {
  const repo = getRepoRoot();
  return new Map([
    ['docs', { label: 'docs/', absPath: join(repo, 'docs') }],
    [
      'claude-learnings',
      { label: 'claude-learnings (~/.claude/learnings)', absPath: join(homedir(), '.claude', 'learnings') },
    ],
    [
      'claude-workbook',
      { label: 'claude-workbook (~/.claude/workbook)', absPath: join(homedir(), '.claude', 'workbook') },
    ],
  ]);
}

function mimeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const map: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jsonc': 'text/plain; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.ts': 'text/typescript; charset=utf-8',
    '.tsx': 'text/typescript; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

function fsErrorToStatusAndMessage(err: unknown): { status: number; message: string } {
  if (!isNodeError(err)) {
    return { status: 500, message: 'Operation failed' };
  }
  switch (err.code) {
    case 'ENOENT':
      return { status: 404, message: 'Not found' };
    case 'ENOTDIR':
    case 'EISDIR':
      return { status: 400, message: err.code === 'ENOTDIR' ? 'Not a directory' : 'Is a directory' };
    case 'EPERM':
    case 'EACCES':
      return { status: 403, message: 'Permission denied' };
    default:
      return { status: 500, message: 'Operation failed' };
  }
}

export class DocsPreviewBackend implements Backend {
  readonly prefix = API_PREFIX;
  private readonly roots = buildRootMap();

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) {
      return null;
    }
    const url = new URL(req.url);

    if (req.method === 'GET' && pathname === `${API_PREFIX}/roots`) {
      return this.handleRoots();
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/list`) {
      return this.handleList(url);
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/raw`) {
      return this.handleRaw(url);
    }

    return new Response(null, { status: 404 });
  }

  private async handleRoots(): Promise<Response> {
    const roots: DocsRootInfo[] = [];
    for (const [id, { label, absPath }] of this.roots) {
      let exists = false;
      try {
        await access(absPath);
        exists = true;
      } catch {
        exists = false;
      }
      roots.push({ id, label, absPath, exists });
    }
    return jsonResponse<RootsResponse>({ roots });
  }

  private resolveRootDir(rootId: string): string | null {
    const entry = this.roots.get(rootId);
    return entry ? entry.absPath : null;
  }

  private async handleList(url: URL): Promise<Response> {
    const rootId = (url.searchParams.get('root') ?? '').trim();
    const rawPath = (url.searchParams.get('path') ?? '').trim().replace(/\\/g, '/');
    const baseDir = this.resolveRootDir(rootId);
    if (!baseDir) {
      return errorResponse('Unknown root', 400);
    }
    const full = resolveSafe(baseDir, rawPath);
    if (full === null) {
      return errorResponse('Invalid path', 400);
    }
    try {
      const st = await stat(full);
      if (!st.isDirectory()) {
        return errorResponse('Not a directory', 400);
      }
      const entries = await readdir(full, { withFileTypes: true });
      const items = await Promise.all(
        entries.map(async (e) => {
          const child = join(full, e.name);
          const rel = relative(baseDir, child).replace(/\\/g, '/');
          const stChild = await stat(child);
          return {
            name: e.name,
            path: rel,
            isDir: e.isDirectory(),
            size: stChild.isFile() ? stChild.size : undefined,
            mtime: stChild.mtimeMs,
          } satisfies FileItem;
        }),
      );
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return jsonResponse<ListResponse>({ items });
    } catch (err) {
      logger.error('[DocsPreviewBackend] list error: %s', err);
      const { status, message } = fsErrorToStatusAndMessage(err);
      return errorResponse(message, status);
    }
  }

  private async handleRaw(url: URL): Promise<Response> {
    const rootId = (url.searchParams.get('root') ?? '').trim();
    const rawPath = (url.searchParams.get('path') ?? '').trim().replace(/\\/g, '/');
    const baseDir = this.resolveRootDir(rootId);
    if (!baseDir) {
      return errorResponse('Unknown root', 400);
    }
    if (!rawPath) {
      return errorResponse('Missing path', 400);
    }
    const full = resolveSafe(baseDir, rawPath);
    if (full === null) {
      return errorResponse('Invalid path', 400);
    }
    try {
      const st = await stat(full);
      if (st.isDirectory()) {
        return errorResponse('Path is a directory', 400);
      }
      if (st.size > MAX_RAW_BYTES) {
        return errorResponse('File too large', 413);
      }
      const type = mimeForPath(full);
      const filename = basename(full);
      const buf = await readFile(full);
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(buf.length),
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      });
    } catch (err) {
      logger.error('[DocsPreviewBackend] raw error: %s', err);
      const { status, message } = fsErrorToStatusAndMessage(err);
      return errorResponse(message, status);
    }
  }
}

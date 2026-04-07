/**
 * File manager backend: REST API (/api/files) only.
 * UI runs on dev server (bun run dev); this server does not serve the frontend.
 *
 * API contract:
 * - GET  /api/files/list?path=   -> { items: FileItem[] }
 * - DELETE /api/files?path=      -> 204 or { error }
 * - POST /api/files/move         -> 204 or { error }  (body: { from, to })
 * - POST /api/files/rename       -> 204 or { error }  (body: { path, newName })
 */

import { readdir, rename, rmdir, stat, unlink } from 'fs/promises';
import { dirname, join, relative, resolve } from 'path';
import { logger } from '@/utils/logger';
import { resolveSafe } from './pathSafety';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/files';

/** Normalized relative path (forward slashes, no leading slash). */
type RelativePath = string;

/** Resolved absolute path under baseDir, or null if invalid/traversal. */
type ResolvedPath = string;

// ---------------------------------------------------------------------------
// API types (request/response)
// ---------------------------------------------------------------------------

/** Single entry in a directory listing (name, relative path, type, size, mtime). */
export interface FileItem {
  name: string;
  path: RelativePath;
  isDir: boolean;
  size?: number;
  mtime?: number;
}

/** Response for GET /api/files/list. */
export interface ListResponse {
  items: FileItem[];
}

/** Request body for POST /api/files/move. */
export interface MoveBody {
  from: string;
  to: string;
}

/** Request body for POST /api/files/rename. */
export interface RenameBody {
  path: string;
  newName: string;
}

/** Error payload returned as JSON on 4xx/5xx. */
export interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** 204 No Content — used for successful delete / move / rename with no body. */
function noContent(): Response {
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Request parsing and path resolution
// ---------------------------------------------------------------------------

/** Parse request body as JSON. Returns null on parse failure (invalid or empty). */
async function parseJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve a relative path against baseDir. Returns null if path is invalid or escapes baseDir.
 * Normalizes backslashes to forward slashes and returns both absolute and relative forms.
 */
function resolvePath(baseDir: string, rawPath: string): { fullPath: ResolvedPath; relativePath: RelativePath } | null {
  const normalized = (rawPath ?? '').trim().replace(/\\/g, '/');
  const full = resolveSafe(baseDir, normalized);
  if (full === null) {
    return null;
  }
  const rel = relative(baseDir, full).replace(/\\/g, '/');
  return { fullPath: full, relativePath: rel };
}

/** True if fullPath is exactly the baseDir (prevents deleting/moving/renaming the root). */
function isRootPath(baseDir: string, fullPath: string): boolean {
  const base = resolve(baseDir);
  const target = resolve(fullPath);
  return base === target;
}

/** Validate filename: non-empty, no path separators. */
function isValidFileName(name: string): boolean {
  const t = (name ?? '').trim();
  return t.length > 0 && !t.includes('/') && !t.includes('\\');
}

// ---------------------------------------------------------------------------
// FS error to HTTP
// ---------------------------------------------------------------------------

/** Type guard for Node fs errors that have err.code. */
function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

/** Map Node fs errno to HTTP status and user-facing message (e.g. ENOENT -> 404). */
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
    case 'ENOTEMPTY':
      return { status: 409, message: 'Directory not empty' };
    case 'EEXIST':
      return { status: 409, message: 'Already exists' };
    case 'EPERM':
    case 'EACCES':
      return { status: 403, message: 'Permission denied' };
    default:
      return { status: 500, message: 'Operation failed' };
  }
}

// ---------------------------------------------------------------------------
// Route definition and dispatch
// ---------------------------------------------------------------------------

/** Async handler for a matched route; receives req and parsed url. */
type Handler = (req: Request, url: URL) => Promise<Response>;

/** Single route: method + path pattern + handler. */
interface Route {
  method: string;
  path: string;
  handler: Handler;
}

export class FileManagerBackend implements Backend {
  readonly prefix = API_PREFIX;
  private readonly baseDir: string;
  /** Route table: first matching (method, path) wins. */
  private readonly routes: Route[];

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
    this.routes = [
      { method: 'GET', path: `${API_PREFIX}/list`, handler: (_req, url) => this.handleList(url) },
      { method: 'DELETE', path: API_PREFIX, handler: (_req, url) => this.handleDelete(url) },
      { method: 'POST', path: `${API_PREFIX}/move`, handler: (req, _url) => this.handleMove(req) },
      { method: 'POST', path: `${API_PREFIX}/rename`, handler: (req, _url) => this.handleRename(req) },
    ];
  }

  /**
   * Entry: if pathname is under /api/files, dispatch to the matching route and return Response.
   * Otherwise return null so the caller can try other handlers (e.g. static host).
   */
  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) {
      return null;
    }
    const url = new URL(req.url);
    for (const route of this.routes) {
      if (req.method === route.method && pathname === route.path) {
        return route.handler(req, url);
      }
    }
    return new Response(null, { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /** GET /api/files/list?path= — list directory contents; path empty = root. */
  private async handleList(url: URL): Promise<Response> {
    const raw = url.searchParams.get('path') ?? '';
    const resolved = resolvePath(this.baseDir, raw);
    if (resolved === null) {
      return errorResponse('Invalid path', 400);
    }
    const { fullPath } = resolved;
    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const items = await Promise.all(
        entries.map(async (e) => {
          const full = join(fullPath, e.name);
          const rel = relative(this.baseDir, full).replace(/\\/g, '/');
          const st = await stat(full);
          return {
            name: e.name,
            path: rel,
            isDir: e.isDirectory(),
            size: st.isFile() ? st.size : undefined,
            mtime: st.mtimeMs,
          } satisfies FileItem;
        }),
      );
      return jsonResponse<ListResponse>({ items });
    } catch (err) {
      logger.error('[FileManagerBackend] list error: %s', err);
      const { status, message } = fsErrorToStatusAndMessage(err);
      return errorResponse(message, status);
    }
  }

  /** DELETE /api/files?path= — delete file or empty directory; root is forbidden. */
  private async handleDelete(url: URL): Promise<Response> {
    const raw = url.searchParams.get('path') ?? '';
    const resolved = resolvePath(this.baseDir, raw);
    if (resolved === null) {
      return errorResponse('Invalid path', 400);
    }
    const { fullPath } = resolved;
    if (isRootPath(this.baseDir, fullPath)) {
      return errorResponse('Cannot delete root', 400);
    }
    try {
      const st = await stat(fullPath);
      if (st.isDirectory()) {
        await rmdir(fullPath); // empty dir only; ENOTEMPTY -> 409
      } else {
        await unlink(fullPath);
      }
      return noContent();
    } catch (err) {
      logger.error('[FileManagerBackend] delete error: %s', err);
      const { status, message } = fsErrorToStatusAndMessage(err);
      return errorResponse(message, status);
    }
  }

  /** POST /api/files/move — body { from, to }; both paths relative to output root. */
  private async handleMove(req: Request): Promise<Response> {
    const body = await parseJsonBody<MoveBody>(req);
    if (body === null) {
      return errorResponse('Invalid JSON', 400);
    }
    const fromPath = (body.from ?? '').trim();
    const toPath = (body.to ?? '').trim();
    if (!fromPath || !toPath) {
      return errorResponse('Missing from or to', 400);
    }
    const fromResolved = resolvePath(this.baseDir, fromPath);
    const toResolved = resolvePath(this.baseDir, toPath);
    if (fromResolved === null || toResolved === null) {
      return errorResponse('Invalid path', 400);
    }
    if (isRootPath(this.baseDir, fromResolved.fullPath)) {
      return errorResponse('Cannot move root', 400);
    }
    try {
      await rename(fromResolved.fullPath, toResolved.fullPath);
      return noContent();
    } catch (err) {
      logger.error('[FileManagerBackend] move error: %s', err);
      const { status, message } = fsErrorToStatusAndMessage(err);
      return errorResponse(message, status);
    }
  }

  /** POST /api/files/rename — body { path, newName }; renames in place (same directory). */
  private async handleRename(req: Request): Promise<Response> {
    const body = await parseJsonBody<RenameBody>(req);
    if (body === null) {
      return errorResponse('Invalid JSON', 400);
    }
    const targetPath = (body.path ?? '').trim();
    const newName = (body.newName ?? '').trim();
    if (!isValidFileName(newName)) {
      return errorResponse('Invalid new name', 400);
    }
    const resolved = resolvePath(this.baseDir, targetPath);
    if (resolved === null) {
      return errorResponse('Invalid path', 400);
    }
    if (isRootPath(this.baseDir, resolved.fullPath)) {
      return errorResponse('Cannot rename root', 400);
    }
    // New path = same parent dir + new name; re-resolve to stay under baseDir.
    const parentDir = dirname(resolved.fullPath);
    const toFull = join(parentDir, newName);
    const toRel = relative(this.baseDir, toFull).replace(/\\/g, '/');
    const toResolved = resolvePath(this.baseDir, toRel);
    if (toResolved === null) {
      return errorResponse('Invalid resulting path', 400);
    }
    try {
      await rename(resolved.fullPath, toResolved.fullPath);
      return noContent();
    } catch (err) {
      logger.error('[FileManagerBackend] rename error: %s', err);
      const { status, message } = fsErrorToStatusAndMessage(err);
      return errorResponse(message, status);
    }
  }
}

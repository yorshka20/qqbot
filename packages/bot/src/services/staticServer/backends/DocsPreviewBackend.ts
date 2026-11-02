/**
 * Read-only docs preview API: browse and fetch local files under fixed roots.
 *
 * Routes:
 * - GET /api/docs/roots  -> { roots: DocsRootInfo[] }
 * - GET /api/docs/list?root=&path=  -> { items: FileItem[] } (paths relative to that root)
 * - GET /api/docs/raw?root=&path=   -> file bytes (path must be a file)
 *
 * Built-in roots (all under monorepo root):
 * - docs: <repo>/docs
 * - claude-learnings: <repo>/_kb/learnings
 * - claude-workbook: <repo>/_kb/workbook
 *
 * The two kb roots are reached through the `_kb` symlink, which points at this
 * project's folder in the local knowledge base; they are empty when that link
 * is missing on a machine.
 *
 * Extra roots can be injected via `DocsPreviewConfig.roots` (see
 * `config.d/webui.jsonc`). Listings filter out a built-in noise deny-list
 * (node_modules, .git, dist, …) plus any user-supplied `exclude` entries.
 */

import { access, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { DocsListResponse, DocsRootInfo, DocsRootsResponse, FileItem } from '@qqbot/api-types';
import { getRepoRoot, logger, resolveFromRepoRoot } from '@qqbot/shared';
import type { DocsPreviewConfig } from '@/core/config/types/docsPreview';
import { type Backend, errorResponse, jsonResponse, registerStaticBackend } from '../backend';
import { resolveSafe } from './pathSafety';

const API_PREFIX = '/api/docs';
const MAX_RAW_BYTES = 15 * 1024 * 1024;

/**
 * Hard-coded noise filter. User-supplied `exclude` entries are appended to
 * this set — these built-ins cannot be disabled, otherwise enabling a `repo`
 * root would surface tens of thousands of `node_modules` entries and stall
 * the WebUI.
 */
const BUILTIN_EXCLUDE = new Set<string>([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  'output',
  '.next',
  '.DS_Store',
]);

function buildBuiltinRoots(): Array<[string, { label: string; absPath: string }]> {
  const repo = getRepoRoot();
  return [
    ['logs', { label: 'logs/', absPath: join(repo, 'logs') }],
    ['claude-learnings', { label: '_kb/learnings/', absPath: join(repo, '_kb', 'learnings') }],
    ['claude-workbook', { label: '_kb/workbook/', absPath: join(repo, '_kb', 'workbook') }],
    ['kb-design', { label: '_kb/design/', absPath: join(repo, '_kb', 'design') }],
    ['kb-tasks', { label: '_kb/tasks/', absPath: join(repo, '_kb', 'tasks') }],
    ['docs', { label: 'docs/', absPath: join(repo, 'docs') }],
    ['data', { label: 'data/', absPath: join(repo, 'data') }],
  ];
}

function buildRootMap(config?: DocsPreviewConfig): Map<string, { label: string; absPath: string }> {
  const roots = new Map<string, { label: string; absPath: string }>(buildBuiltinRoots());
  for (const extra of config?.roots ?? []) {
    const id = extra.id?.trim();
    if (!id) {
      logger.warn('[DocsPreviewBackend] Skipping root with empty id');
      continue;
    }
    if (roots.has(id)) {
      logger.warn(`[DocsPreviewBackend] Duplicate root id '${id}' — keeping the earlier definition`);
      continue;
    }
    if (!extra.path?.trim()) {
      logger.warn(`[DocsPreviewBackend] Skipping root '${id}' with empty path`);
      continue;
    }
    roots.set(id, {
      label: extra.label?.trim() || `${id}/`,
      absPath: resolveFromRepoRoot(extra.path),
    });
  }
  return roots;
}

function buildExcludeSet(config?: DocsPreviewConfig): Set<string> {
  const set = new Set<string>(BUILTIN_EXCLUDE);
  for (const raw of config?.exclude ?? []) {
    const name = raw?.trim();
    if (name) {
      set.add(name);
    }
  }
  return set;
}

function mimeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const map: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.jsonl': 'text/plain; charset=utf-8',
    '.ndjson': 'text/plain; charset=utf-8',
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
  private readonly roots: Map<string, { label: string; absPath: string }>;
  private readonly excluded: Set<string>;

  constructor(config?: DocsPreviewConfig) {
    this.roots = buildRootMap(config);
    this.excluded = buildExcludeSet(config);
  }

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
    return jsonResponse<DocsRootsResponse>({ roots });
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
      const rawEntries = await readdir(full, { withFileTypes: true });
      // Filter noise BEFORE stat() — listing `repo` root otherwise stat()s
      // every node_modules child and stalls the WebUI.
      const entries = rawEntries.filter((e) => !this.excluded.has(e.name));
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
      return jsonResponse<DocsListResponse>({ items });
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

registerStaticBackend({ id: 'docs', create: (ctx) => new DocsPreviewBackend(ctx.config?.getDocsPreviewConfig()) });

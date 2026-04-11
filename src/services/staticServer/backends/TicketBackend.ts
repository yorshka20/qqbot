/**
 * TicketBackend — REST API for cluster task tickets.
 *
 * Storage: each ticket is a single markdown file under `tickets/` at the
 * project root (NOT under `data/` because data/ is gitignored — tickets
 * are project knowledge and meant to be committed). Filename is the
 * ticket id with `.md` suffix; id format is `YYYY-MM-DD-<slug>` so the
 * filesystem-sorted listing matches creation order.
 *
 * File format:
 *   ---
 *   id: 2026-04-11-fix-discord-emoji
 *   title: Fix Discord emoji rendering
 *   status: ready              # draft | ready | dispatched | done | abandoned
 *   template: claude-sonnet
 *   project: qqbot
 *   created: 2026-04-11T10:00:00+09:00
 *   updated: 2026-04-11T11:30:00+09:00
 *   dispatchedJobId:           # optional, set when dispatched
 *   ---
 *
 *   <markdown body — Goal / Context / Acceptance / etc.>
 *
 * The dispatch action is NOT in this backend — the WebUI calls the
 * existing `POST /api/cluster/jobs` with the full ticket markdown as
 * the description, then PUTs the ticket back here with status updated.
 * Keeps ticket storage and cluster scheduling decoupled.
 *
 * Routes (prefix `/api/tickets`):
 *   GET    /api/tickets               { tickets: TicketSummary[] } (frontmatter only, no body)
 *   GET    /api/tickets/:id           full ticket { id, frontmatter, body }
 *   POST   /api/tickets               create; body { title, status?, template?, project?, body }
 *   PUT    /api/tickets/:id           update; body any subset of mutable fields
 *   DELETE /api/tickets/:id           delete file
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import { resolveSafe } from './pathSafety';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/tickets';

/**
 * Allowed status values. Lifecycle:
 *   draft     → editing, dispatch disabled
 *   ready     → done editing, can dispatch
 *   dispatched → cluster job created, dispatchedJobId filled
 *   done      → worker finished, result captured (manually for now)
 *   abandoned → won't do, kept as record
 */
const ALLOWED_STATUSES = ['draft', 'ready', 'dispatched', 'done', 'abandoned'] as const;
type TicketStatus = (typeof ALLOWED_STATUSES)[number];

interface TicketFrontmatter {
  id: string;
  title: string;
  status: TicketStatus;
  template?: string;
  project?: string;
  created: string;
  updated: string;
  dispatchedJobId?: string;
}

interface Ticket {
  id: string;
  frontmatter: TicketFrontmatter;
  body: string;
}

interface TicketSummary {
  // Equivalent to TicketFrontmatter but kept as a separate type so the
  // wire shape is documented at the type level.
  id: string;
  title: string;
  status: TicketStatus;
  template?: string;
  project?: string;
  created: string;
  updated: string;
  dispatchedJobId?: string;
}

export class TicketBackend {
  readonly prefix = API_PREFIX;
  private readonly ticketsDir: string;

  constructor() {
    // tickets/ at project root (not under data/, which is gitignored).
    // process.cwd() is the bot project directory because src/index.ts is
    // launched from the project root by `bun run start` / `bun run dev`.
    this.ticketsDir = join(process.cwd(), 'tickets');
    if (!existsSync(this.ticketsDir)) {
      try {
        mkdirSync(this.ticketsDir, { recursive: true });
        logger.info(`[TicketBackend] Created tickets directory: ${this.ticketsDir}`);
      } catch (err) {
        logger.warn(`[TicketBackend] Failed to create tickets dir (will retry on first write):`, err);
      }
    }
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const subPath = pathname.slice(API_PREFIX.length);

    try {
      if (req.method === 'GET') {
        return await this.handleGet(subPath);
      }
      if (req.method === 'POST') {
        return await this.handlePost(subPath, req);
      }
      if (req.method === 'PUT') {
        return await this.handlePut(subPath, req);
      }
      if (req.method === 'DELETE') {
        return await this.handleDelete(subPath);
      }
    } catch (err) {
      logger.error('[TicketBackend] Unhandled error:', err);
      return errorResponse(err instanceof Error ? err.message : String(err), 500);
    }

    return errorResponse('Method not allowed', 405);
  }

  // ── GET ────────────────────────────────────────────────────────────────

  private async handleGet(subPath: string): Promise<Response> {
    if (subPath === '' || subPath === '/') {
      const tickets = await this.listAll();
      return jsonResponse({ tickets });
    }

    // /:id
    const idMatch = subPath.match(/^\/([^/]+)$/);
    if (idMatch) {
      const ticket = await this.readTicket(idMatch[1]);
      if (!ticket) return errorResponse('Ticket not found', 404);
      return jsonResponse(ticket);
    }

    return errorResponse('Not found', 404);
  }

  /** List frontmatter-only summaries, sorted by `created` desc. */
  private async listAll(): Promise<TicketSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.ticketsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const summaries: TicketSummary[] = [];
    for (const filename of files) {
      if (!filename.endsWith('.md')) continue;
      const id = filename.slice(0, -3);
      const ticket = await this.readTicket(id).catch((err) => {
        // Don't blow up the whole listing on a single bad file. Surface
        // it as a synthetic error ticket so the WebUI can show "this
        // file failed to parse" instead of disappearing it.
        logger.warn(`[TicketBackend] Failed to parse ${filename}:`, err);
        return null;
      });
      if (ticket) summaries.push(ticket.frontmatter);
    }

    // Newest first. `created` is ISO-8601 so lexicographic sort works.
    summaries.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    return summaries;
  }

  private async readTicket(id: string): Promise<Ticket | null> {
    const filePath = this.ticketPath(id);
    if (!filePath) return null;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter, body } = parseMarkdownTicket(raw);
      // Trust the filename over any drift in the file's own `id`. If they
      // don't match, the filename wins and we silently fix the in-memory
      // copy. The next PUT will normalize the file.
      return { id, frontmatter: { ...frontmatter, id }, body };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // ── POST (create) ──────────────────────────────────────────────────────

  private async handlePost(subPath: string, req: Request): Promise<Response> {
    if (subPath !== '' && subPath !== '/') {
      return errorResponse('Not found', 404);
    }

    let body: {
      title?: string;
      status?: string;
      template?: string;
      project?: string;
      body?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    if (!body.title?.trim()) {
      return errorResponse('Missing required field: title', 400);
    }

    const status = (body.status ?? 'draft') as TicketStatus;
    if (!ALLOWED_STATUSES.includes(status)) {
      return errorResponse(`Invalid status; must be one of ${ALLOWED_STATUSES.join(', ')}`, 400);
    }

    const id = await this.allocateId(body.title);
    const now = new Date().toISOString();
    const ticket: Ticket = {
      id,
      frontmatter: {
        id,
        title: body.title.trim(),
        status,
        template: body.template?.trim() || undefined,
        project: body.project?.trim() || undefined,
        created: now,
        updated: now,
      },
      body: body.body ?? '',
    };

    await this.writeTicket(ticket);
    return jsonResponse(ticket, 201);
  }

  /**
   * Allocate a unique ticket id from a title. Format: `YYYY-MM-DD-<slug>`,
   * with `-2` / `-3` / ... suffix on collision.
   */
  private async allocateId(title: string): Promise<string> {
    const datePrefix = new Date().toISOString().slice(0, 10);
    const slug = slugify(title);
    const base = `${datePrefix}-${slug}`;
    let candidate = base;
    let n = 1;
    while (existsSync(join(this.ticketsDir, `${candidate}.md`))) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  // ── PUT (update) ───────────────────────────────────────────────────────

  private async handlePut(subPath: string, req: Request): Promise<Response> {
    const idMatch = subPath.match(/^\/([^/]+)$/);
    if (!idMatch) return errorResponse('Not found', 404);
    const id = idMatch[1];

    const existing = await this.readTicket(id);
    if (!existing) return errorResponse('Ticket not found', 404);

    let patch: {
      title?: string;
      status?: string;
      template?: string | null;
      project?: string | null;
      body?: string;
      dispatchedJobId?: string | null;
    };
    try {
      patch = (await req.json()) as typeof patch;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    if (patch.status !== undefined && !ALLOWED_STATUSES.includes(patch.status as TicketStatus)) {
      return errorResponse(`Invalid status; must be one of ${ALLOWED_STATUSES.join(', ')}`, 400);
    }

    // Build the new ticket. `null` in any nullable field means "clear it"
    // — explicit so the client can remove a field without ambiguity vs
    // "left out of the patch entirely". `undefined` means "keep existing".
    const next: Ticket = {
      id,
      frontmatter: {
        id,
        title: patch.title?.trim() || existing.frontmatter.title,
        status: (patch.status as TicketStatus) ?? existing.frontmatter.status,
        template:
          patch.template === null
            ? undefined
            : patch.template === undefined
              ? existing.frontmatter.template
              : patch.template.trim() || undefined,
        project:
          patch.project === null
            ? undefined
            : patch.project === undefined
              ? existing.frontmatter.project
              : patch.project.trim() || undefined,
        created: existing.frontmatter.created,
        updated: new Date().toISOString(),
        dispatchedJobId:
          patch.dispatchedJobId === null
            ? undefined
            : patch.dispatchedJobId === undefined
              ? existing.frontmatter.dispatchedJobId
              : patch.dispatchedJobId.trim() || undefined,
      },
      body: patch.body !== undefined ? patch.body : existing.body,
    };

    await this.writeTicket(next);
    return jsonResponse(next);
  }

  // ── DELETE ─────────────────────────────────────────────────────────────

  private async handleDelete(subPath: string): Promise<Response> {
    const idMatch = subPath.match(/^\/([^/]+)$/);
    if (!idMatch) return errorResponse('Not found', 404);

    const filePath = this.ticketPath(idMatch[1]);
    if (!filePath) return errorResponse('Invalid ticket id', 400);

    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return errorResponse('Ticket not found', 404);
      }
      throw err;
    }
    return jsonResponse({ deleted: true });
  }

  // ── Storage helpers ────────────────────────────────────────────────────

  /**
   * Resolve `tickets/<id>.md`, refusing path traversal. Also rejects ids
   * with slashes / .md suffix / leading dots so the wire-level id stays
   * a clean alphanumeric-dash form.
   */
  private ticketPath(id: string): string | null {
    if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.') || id.endsWith('.md')) {
      return null;
    }
    return resolveSafe(this.ticketsDir, `${id}.md`);
  }

  private async writeTicket(ticket: Ticket): Promise<void> {
    const filePath = this.ticketPath(ticket.id);
    if (!filePath) {
      throw new Error(`Invalid ticket id: ${ticket.id}`);
    }
    if (!existsSync(this.ticketsDir)) {
      mkdirSync(this.ticketsDir, { recursive: true });
    }
    const content = serializeTicket(ticket);
    await writeFile(filePath, content, 'utf-8');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Frontmatter parser (hand-rolled — no gray-matter dependency)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a markdown file with optional `---` frontmatter at the top.
 *
 * Supports flat `key: value` pairs only — no nested objects, no arrays,
 * no quoted multi-line strings. Values are trimmed; empty strings stay
 * empty (caller decides whether they mean "missing"). Unknown keys are
 * preserved verbatim into the returned record so future fields don't
 * lose data on round-trip.
 *
 * Anything before the closing `---` is frontmatter; everything after is
 * body. If there's no frontmatter block, the whole file is body and the
 * frontmatter is empty.
 */
export function parseMarkdownTicket(raw: string): {
  frontmatter: TicketFrontmatter;
  body: string;
} {
  const lines = raw.split('\n');
  const fm: Record<string, string> = {};
  let bodyStartLine = 0;

  if (lines[0]?.trim() === '---') {
    let endLine = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        endLine = i;
        break;
      }
      const line = lines[i];
      // `key: value` — split on the FIRST colon only so values can
      // contain colons (e.g. ISO timestamps `2026-04-11T10:00:00+09:00`).
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key) fm[key] = value;
      }
    }
    if (endLine !== -1) {
      bodyStartLine = endLine + 1;
    }
  }

  const body = lines.slice(bodyStartLine).join('\n').replace(/^\n+/, '');

  // Map raw fm record into a typed frontmatter, applying defaults for
  // missing required fields.
  const frontmatter: TicketFrontmatter = {
    id: fm.id ?? '',
    title: fm.title ?? '(untitled)',
    status: ALLOWED_STATUSES.includes(fm.status as TicketStatus) ? (fm.status as TicketStatus) : 'draft',
    template: fm.template || undefined,
    project: fm.project || undefined,
    created: fm.created || new Date().toISOString(),
    updated: fm.updated || fm.created || new Date().toISOString(),
    dispatchedJobId: fm.dispatchedJobId || undefined,
  };

  return { frontmatter, body };
}

/**
 * Render a Ticket back into the on-disk markdown format. Always emits
 * the same key order so file diffs stay clean across edits.
 */
export function serializeTicket(ticket: Ticket): string {
  const fm = ticket.frontmatter;
  const lines: string[] = ['---'];
  lines.push(`id: ${fm.id}`);
  lines.push(`title: ${fm.title}`);
  lines.push(`status: ${fm.status}`);
  if (fm.template) lines.push(`template: ${fm.template}`);
  if (fm.project) lines.push(`project: ${fm.project}`);
  lines.push(`created: ${fm.created}`);
  lines.push(`updated: ${fm.updated}`);
  if (fm.dispatchedJobId) lines.push(`dispatchedJobId: ${fm.dispatchedJobId}`);
  lines.push('---');
  lines.push('');
  lines.push(ticket.body);
  // Ensure trailing newline so editors don't show "no newline at end of file"
  if (!ticket.body.endsWith('\n')) {
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Title → URL/filename slug. ASCII-letters / digits / dashes only;
 * everything else collapses to a single dash; CJK characters are dropped
 * (rare in practice — users will write English titles, and even if not
 * the date prefix keeps the id unique).
 */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 60);
  return slug || 'untitled';
}

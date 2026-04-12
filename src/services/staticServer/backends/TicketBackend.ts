/**
 * TicketBackend — REST API for cluster task tickets.
 *
 * Storage: each ticket is a **directory** under `tickets/` at the project
 * root (NOT under `data/` because data/ is gitignored — tickets are project
 * knowledge and meant to be committed). Directory name is the ticket id;
 * id format is `YYYY-MM-DD-<slug>` so the filesystem-sorted listing
 * matches creation order.
 *
 * Directory layout:
 *   tickets/<id>/
 *     ticket.md              — frontmatter + markdown body (the "ticket")
 *     results/               — auto-generated execution artifacts
 *       summary.md           — job completion summary
 *       task-<taskId>.md     — per-task input (description) + output
 *
 * Backward compat: if `tickets/<id>.md` exists (pre-directory era), it is
 * auto-migrated into `tickets/<id>/ticket.md` on first read.
 *
 * The dispatch action is NOT in this backend — the WebUI calls the
 * existing `POST /api/cluster/jobs` with the full ticket markdown as
 * the description, then PUTs the ticket back here with status updated.
 * Keeps ticket storage and cluster scheduling decoupled.
 *
 * Routes (prefix `/api/tickets`):
 *   GET    /api/tickets               { tickets: TicketSummary[] } (frontmatter only, no body)
 *   GET    /api/tickets/:id           full ticket { id, frontmatter, body }
 *   GET    /api/tickets/:id/results   list result files
 *   GET    /api/tickets/:id/results/:file  read a specific result file
 *   POST   /api/tickets               create; body { title, status?, template?, project?, body }
 *   PUT    /api/tickets/:id           update; body any subset of mutable fields
 *   DELETE /api/tickets/:id           delete directory
 */

import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  /**
   * Phase 3 multi-agent: when `true`, dispatching this ticket forces the
   * scheduler to pick a planner-role worker template instead of a regular
   * executor. The selected template must have `role: 'planner'` in cluster
   * config — see `cluster.defaultPlannerTemplate` for the fallback used
   * when this ticket doesn't pin its own `template`.
   */
  usePlanner?: boolean;
  /**
   * Phase 3 multi-agent: optional cap on how many child workers the planner
   * is allowed to spawn. Currently only surfaced to the planner via the
   * prompt — the hub does NOT hard-enforce this number (would require
   * tracking spawn counts per planner). Default is 5 (mirrored in the
   * planner system prompt).
   */
  maxChildren?: number;
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
  usePlanner?: boolean;
  maxChildren?: number;
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

    // /:id/results/:file — read a specific result file
    const resultFileMatch = subPath.match(/^\/([^/]+)\/results\/([^/]+)$/);
    if (resultFileMatch) {
      return this.handleGetResultFile(resultFileMatch[1], resultFileMatch[2]);
    }

    // /:id/results — list result files
    const resultsMatch = subPath.match(/^\/([^/]+)\/results$/);
    if (resultsMatch) {
      return this.handleListResults(resultsMatch[1]);
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

  private async handleListResults(id: string): Promise<Response> {
    const dir = this.ticketDir(id);
    if (!dir) return errorResponse('Invalid ticket id', 400);
    const resultsDir = join(dir, 'results');
    try {
      const files = await readdir(resultsDir);
      return jsonResponse({ files: files.filter((f) => f.endsWith('.md')) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return jsonResponse({ files: [] });
      throw err;
    }
  }

  private async handleGetResultFile(id: string, filename: string): Promise<Response> {
    const dir = this.ticketDir(id);
    if (!dir) return errorResponse('Invalid ticket id', 400);
    // Prevent path traversal
    if (filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
      return errorResponse('Invalid filename', 400);
    }
    const filePath = join(dir, 'results', filename);
    try {
      const content = await readFile(filePath, 'utf-8');
      return jsonResponse({ filename, content });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return errorResponse('Result file not found', 404);
      throw err;
    }
  }

  /** List frontmatter-only summaries, sorted by `created` desc. */
  private async listAll(): Promise<TicketSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.ticketsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const summaries: TicketSummary[] = [];
    for (const entry of entries) {
      // New format: directory with ticket.md inside
      // Legacy format: <id>.md file (auto-migrated on read)
      let id: string;
      const fullPath = join(this.ticketsDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          id = entry;
        } else if (entry.endsWith('.md')) {
          id = entry.slice(0, -3);
        } else {
          continue;
        }
      } catch {
        continue;
      }

      const ticket = await this.readTicket(id).catch((err) => {
        logger.warn(`[TicketBackend] Failed to parse ${entry}:`, err);
        return null;
      });
      if (ticket) summaries.push(ticket.frontmatter);
    }

    // Newest first. `created` is ISO-8601 so lexicographic sort works.
    summaries.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    return summaries;
  }

  private async readTicket(id: string): Promise<Ticket | null> {
    const dir = this.ticketDir(id);
    if (!dir) return null;

    // Auto-migrate legacy single-file format → directory format
    const legacyPath = join(this.ticketsDir, `${id}.md`);
    if (!existsSync(dir) && existsSync(legacyPath)) {
      try {
        mkdirSync(dir, { recursive: true });
        renameSync(legacyPath, join(dir, 'ticket.md'));
        logger.info(`[TicketBackend] Migrated legacy ticket ${id}.md → ${id}/ticket.md`);
      } catch (err) {
        logger.warn(`[TicketBackend] Failed to migrate legacy ticket ${id}:`, err);
        // Fall through — try to read from whichever location exists
      }
    }

    const filePath = join(dir, 'ticket.md');
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter, body } = parseMarkdownTicket(raw);
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
      usePlanner?: boolean;
      maxChildren?: number;
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
        usePlanner: body.usePlanner === true ? true : undefined,
        maxChildren: typeof body.maxChildren === 'number' && body.maxChildren > 0 ? body.maxChildren : undefined,
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
    // Check both directory (new format) and file (legacy) to avoid collisions
    while (existsSync(join(this.ticketsDir, candidate)) || existsSync(join(this.ticketsDir, `${candidate}.md`))) {
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
      usePlanner?: boolean | null;
      maxChildren?: number | null;
    };
    try {
      patch = (await req.json()) as typeof patch;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    if (patch.status !== undefined && !ALLOWED_STATUSES.includes(patch.status as TicketStatus)) {
      return errorResponse(`Invalid status; must be one of ${ALLOWED_STATUSES.join(', ')}`, 400);
    }

    // Build the new ticket. Nullable fields follow these PATCH semantics:
    //   null      → clear the field (explicit "remove this")
    //   undefined → keep the existing value (field not in patch)
    //   value     → set after running through `sanitize` (whitespace
    //               trimming, range checks, etc. — sanitize returns
    //               undefined if the value collapses to "no value")
    const trimmedString = (v: string): string | undefined => v.trim() || undefined;
    const trueOrUndefined = (v: boolean): boolean | undefined => (v === true ? true : undefined);
    const positiveInt = (v: number): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

    const next: Ticket = {
      id,
      frontmatter: {
        id,
        title: patch.title?.trim() || existing.frontmatter.title,
        status: (patch.status as TicketStatus) ?? existing.frontmatter.status,
        template: patchField(patch.template, existing.frontmatter.template, trimmedString),
        project: patchField(patch.project, existing.frontmatter.project, trimmedString),
        created: existing.frontmatter.created,
        updated: new Date().toISOString(),
        dispatchedJobId: patchField(patch.dispatchedJobId, existing.frontmatter.dispatchedJobId, trimmedString),
        usePlanner: patchField(patch.usePlanner, existing.frontmatter.usePlanner, trueOrUndefined),
        maxChildren: patchField(patch.maxChildren, existing.frontmatter.maxChildren, positiveInt),
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

    const dir = this.ticketDir(idMatch[1]);
    if (!dir) return errorResponse('Invalid ticket id', 400);

    try {
      await rm(dir, { recursive: true });
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
   * Resolve `tickets/<id>/` directory, refusing path traversal.
   */
  private ticketDir(id: string): string | null {
    if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.') || id.endsWith('.md')) {
      return null;
    }
    return resolveSafe(this.ticketsDir, id);
  }

  /**
   * Get the results directory for a ticket. Creates it if needed.
   */
  getResultsDir(id: string): string | null {
    const dir = this.ticketDir(id);
    if (!dir) return null;
    const resultsDir = join(dir, 'results');
    if (!existsSync(resultsDir)) {
      mkdirSync(resultsDir, { recursive: true });
    }
    return resultsDir;
  }

  /**
   * Write a result file into the ticket's results/ directory.
   * Used by the cluster writeback mechanism.
   */
  async writeResult(ticketId: string, filename: string, content: string): Promise<boolean> {
    const resultsDir = this.getResultsDir(ticketId);
    if (!resultsDir) return false;
    try {
      await writeFile(join(resultsDir, filename), content, 'utf-8');
      return true;
    } catch (err) {
      logger.warn(`[TicketBackend] Failed to write result ${filename} for ticket ${ticketId}:`, err);
      return false;
    }
  }

  private async writeTicket(ticket: Ticket): Promise<void> {
    const dir = this.ticketDir(ticket.id);
    if (!dir) {
      throw new Error(`Invalid ticket id: ${ticket.id}`);
    }
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const content = serializeTicket(ticket);
    await writeFile(join(dir, 'ticket.md'), content, 'utf-8');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// PATCH helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Apply one field of a PUT patch using the standard tri-state semantics
 * the TicketBackend exposes:
 *
 *   patchValue === null      → clear (return undefined)
 *   patchValue === undefined → keep existing
 *   patchValue is a value    → run through `sanitize`, return result
 *
 * `sanitize` lets each field collapse a "looks-like-set-but-actually-empty"
 * input back into `undefined` (empty-after-trim string, non-positive
 * number, false boolean, etc.) without the caller having to repeat the
 * three-branch ternary at every field.
 */
function patchField<TIn, TOut>(
  patchValue: TIn | null | undefined,
  existing: TOut | undefined,
  sanitize: (v: TIn) => TOut | undefined,
): TOut | undefined {
  if (patchValue === null) return undefined;
  if (patchValue === undefined) return existing;
  return sanitize(patchValue);
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

  // Phase 3: parse usePlanner and maxChildren if present. usePlanner is a
  // bool: case-insensitive "true" only — anything else is treated as false
  // (we don't want a malformed value to silently switch dispatch semantics).
  // maxChildren parses as a positive integer; non-numeric / zero / negative
  // values fall back to undefined.
  const rawUsePlanner = fm.usePlanner?.toLowerCase();
  const usePlanner = rawUsePlanner === 'true' ? true : undefined;
  const rawMaxChildren = fm.maxChildren ? Number.parseInt(fm.maxChildren, 10) : NaN;
  const maxChildren = Number.isFinite(rawMaxChildren) && rawMaxChildren > 0 ? rawMaxChildren : undefined;

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
    usePlanner,
    maxChildren,
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
  if (fm.usePlanner) lines.push(`usePlanner: true`);
  if (fm.maxChildren) lines.push(`maxChildren: ${fm.maxChildren}`);
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

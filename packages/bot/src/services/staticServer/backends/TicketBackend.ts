/**
 * TicketBackend — REST API for cluster task tickets.
 *
 * Storage: each ticket is a **directory** under the configured tickets
 * directory (see `TicketsConfig` / `Config.getTicketsDir()`). By default
 * this is `<cwd>/tickets`; typical production setup points it at an
 * external `cluster-tickets` repo so cross-project work items can live in
 * their own git history and be shared across bot instances.
 *
 * Directory name is the ticket id; id format is `YYYY-MM-DD-<slug>` so
 * filesystem-sorted listing matches creation order.
 *
 * Directory layout under `ticketsDir`:
 *   .templates/ticket.md     — default body skeleton rendered by WebUI
 *   <id>/
 *     ticket.md              — frontmatter + markdown body (the "ticket")
 *     plan.md                — planner's decomposition plan (optional)
 *     plan-v<N>.md           — archived plan revisions (optional)
 *     results/               — auto-generated execution artifacts
 *       summary.md           — job completion summary
 *       task-<taskId>.md     — per-task input (description) + output
 *
 * Backward compat: if `<ticketsDir>/<id>.md` exists (pre-directory era),
 * it is auto-migrated into `<ticketsDir>/<id>/ticket.md` on first read.
 *
 * The dispatch action is NOT in this backend — the WebUI calls the
 * existing `POST /api/cluster/jobs` with the full ticket markdown as
 * the description, then PUTs the ticket back here with status updated.
 * Keeps ticket storage and cluster scheduling decoupled.
 *
 * Routes (prefix `/api/tickets`):
 *   GET    /api/tickets               { tickets: TicketSummary[] } (frontmatter only, no body)
 *   GET    /api/tickets/template      { content } — default ticket body template
 *   GET    /api/tickets/:id           full ticket { id, frontmatter, body }
 *   GET    /api/tickets/:id/results   list result files
 *   GET    /api/tickets/:id/results/:file  read a specific result file
 *   POST   /api/tickets               create; body { title, status?, template?, project?, body }
 *   PUT    /api/tickets/:id           update; body any subset of mutable fields
 *   DELETE /api/tickets/:id           delete directory
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '@/utils/logger';
import {
  bucketForProject,
  findTicketDir,
  idTaken,
  isValidTicketId,
  iterateAllTickets,
  ticketDirForCreate,
} from './ticketStorage';
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
   * Phase 3 multi-agent: optional cap on how many child workers the planner
   * is allowed to spawn. Only meaningful when the selected `template` has
   * `role: 'planner'` — otherwise ignored. Surfaced to the planner via the
   * prompt; the hub does NOT hard-enforce this number. Default is 5
   * (mirrored in the planner system prompt).
   */
  maxChildren?: number;
  /**
   * Hints to the planner about task complexity, used for executor selection:
   *   trivial | low  → planner may dispatch as a single task directly
   *   medium             → normal executor selection
   *   high              → planner should consider claude-sonnet executor
   */
  estimatedComplexity?: 'trivial' | 'low' | 'medium' | 'high';
}

interface Ticket {
  id: string;
  frontmatter: TicketFrontmatter;
  body: string;
  /**
   * Plan artifact attached to this ticket, if the cluster planner wrote one
   * via `hub_write_plan`. Lives at `tickets/<id>/plan.md`. `null` when no
   * plan has been written yet (non-planner tickets always have `null`).
   * Archives (`plan-v<N>.md`) live next to `plan.md`; not included here to
   * keep the detail response small — the WebUI can list them separately if
   * it needs to surface history.
   */
  plan?: TicketPlan | null;
}

interface TicketPlan {
  content: string;
  /** Parsed from `plan_version` field in the plan.md frontmatter, if present. */
  version?: number;
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
  maxChildren?: number;
  estimatedComplexity?: 'trivial' | 'low' | 'medium' | 'high';
}

export class TicketBackend {
  readonly prefix = API_PREFIX;
  private readonly ticketsDir: string;

  /**
   * @param ticketsDir Absolute path to the tickets root. Provided by
   *   `createBackends()` from `Config.getTicketsDir()`. This path may live
   *   outside the bot repo (e.g. a dedicated `cluster-tickets` repo).
   *
   * On construction we run a one-shot migration that moves any tickets
   * sitting at the root (legacy flat layout) into their `<project>/`
   * bucket. See `migrateFlatLayoutToBuckets`.
   */
  constructor(ticketsDir: string) {
    this.ticketsDir = ticketsDir;
    if (!existsSync(this.ticketsDir)) {
      try {
        mkdirSync(this.ticketsDir, { recursive: true });
        logger.info(`[TicketBackend] Created tickets directory: ${this.ticketsDir}`);
      } catch (err) {
        logger.warn(`[TicketBackend] Failed to create tickets dir (will retry on first write):`, err);
      }
    } else {
      logger.info(`[TicketBackend] Using tickets directory: ${this.ticketsDir}`);
    }
    this.migrateFlatLayoutToBuckets();
  }

  /**
   * Move any tickets still sitting at `<ticketsDir>/<id>/` (legacy flat
   * layout, pre 2026-04-16 batch4) into their project bucket
   * `<ticketsDir>/<project>/<id>/`. Tickets without a `project` field
   * land in `_unassigned/`.
   *
   * Skipped:
   *   - Hidden entries (`.templates`, `.git`, `.DS_Store`)
   *   - Directories without `ticket.md` (user-created notes folders)
   *   - Plain files (e.g. README.md)
   *   - Directories that are themselves project buckets (no ticket.md
   *     direct child but contains nested `<id>/ticket.md` — those have
   *     already been migrated)
   *
   * Runs synchronously in the constructor so any subsequent read uses the
   * post-migration layout. Failures are warnings, not fatals — a partial
   * migration is preferable to refusing to boot.
   */
  private migrateFlatLayoutToBuckets(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.ticketsDir);
    } catch {
      return;
    }

    let moved = 0;
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(this.ticketsDir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const ticketMdPath = join(fullPath, 'ticket.md');
      // Only migrate if ticket.md is a direct child — otherwise this is
      // either a project bucket (no ticket.md at this level, just nested
      // <id>/ dirs) or a user-created notes folder.
      if (!existsSync(ticketMdPath)) continue;

      // Read frontmatter to determine project bucket. If we can't parse,
      // bail on this one and warn — leave the dir where it is rather than
      // shove it into _unassigned and lose its identity.
      let project: string | undefined;
      try {
        const raw = readFileSync(ticketMdPath, 'utf-8');
        const { frontmatter } = parseMarkdownTicket(raw);
        project = frontmatter.project;
      } catch (err) {
        logger.warn(`[TicketBackend] Migration: failed to parse ${ticketMdPath}, leaving in place:`, err);
        continue;
      }

      const bucket = bucketForProject(project);
      const bucketDir = join(this.ticketsDir, bucket);
      const targetDir = join(bucketDir, entry);
      if (existsSync(targetDir)) {
        logger.warn(
          `[TicketBackend] Migration: target ${targetDir} already exists, skipping ${entry} (manual cleanup needed)`,
        );
        continue;
      }

      try {
        if (!existsSync(bucketDir)) mkdirSync(bucketDir, { recursive: true });
        renameSync(fullPath, targetDir);
        moved += 1;
        logger.info(`[TicketBackend] Migrated ${entry} → ${bucket}/${entry}`);
      } catch (err) {
        logger.warn(`[TicketBackend] Migration: failed to move ${entry} → ${bucket}/:`, err);
      }
    }

    if (moved > 0) {
      logger.info(`[TicketBackend] Bucket migration complete: ${moved} ticket(s) moved into project subfolders`);
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

  /**
   * Serve the default ticket body skeleton. Reads `.templates/ticket.md`
   * from inside the tickets directory so the template ships with (and is
   * version-controlled alongside) the tickets themselves. Returns 404 if
   * the file is missing — the WebUI falls back to an empty textarea, and
   * the fix is to commit a template into `<ticketsDir>/.templates/`.
   *
   * The `.templates/` prefix is hidden from the ticket listing in
   * `listAll()` so this directory doesn't masquerade as a ticket.
   */
  private async handleGetTemplate(): Promise<Response> {
    const templatePath = join(this.ticketsDir, '.templates', 'ticket.md');
    try {
      const content = await readFile(templatePath, 'utf-8');
      return jsonResponse({ content });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(`[TicketBackend] Ticket template not found at ${templatePath}`);
        return errorResponse('Ticket template not found', 404);
      }
      throw err;
    }
  }

  private async handleGet(subPath: string): Promise<Response> {
    if (subPath === '' || subPath === '/') {
      const tickets = await this.listAll();
      return jsonResponse({ tickets });
    }

    // /template — return the default ticket template body
    if (subPath === '/template') {
      return this.handleGetTemplate();
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
    const dir = findTicketDir(this.ticketsDir, id);
    if (!dir) return errorResponse('Ticket not found', 404);
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
    const dir = findTicketDir(this.ticketsDir, id);
    if (!dir) return errorResponse('Ticket not found', 404);
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
    const summaries: TicketSummary[] = [];
    for (const { id, ticketDir } of iterateAllTickets(this.ticketsDir)) {
      try {
        const raw = await readFile(join(ticketDir, 'ticket.md'), 'utf-8');
        const { frontmatter } = parseMarkdownTicket(raw);
        summaries.push({ ...frontmatter, id });
      } catch (err) {
        logger.warn(`[TicketBackend] Failed to parse ${ticketDir}/ticket.md:`, err);
      }
    }
    // Newest first. `created` is ISO-8601 so lexicographic sort works.
    summaries.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    return summaries;
  }

  private async readTicket(id: string): Promise<Ticket | null> {
    if (!isValidTicketId(id)) return null;
    const dir = findTicketDir(this.ticketsDir, id);
    if (!dir) return null;

    const filePath = join(dir, 'ticket.md');
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter, body } = parseMarkdownTicket(raw);
      const plan = await this.readPlan(dir);
      return { id, frontmatter: { ...frontmatter, id }, body, plan };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Read `<ticketDir>/plan.md` if it exists and attach a lightweight
   * `TicketPlan` payload (content + parsed version). Returns `null` if
   * the file isn't there or can't be read — plan is optional.
   *
   * Version parsing scans only the YAML-like frontmatter block; it does
   * NOT reuse `parseMarkdownTicket` because plan.md uses a different
   * frontmatter schema (see `prompts/cluster/plan-schema.md`) and we only
   * care about one field. A tiny inline regex is more honest than
   * coercing the result of a ticket parser into a plan parser.
   */
  private async readPlan(ticketDir: string): Promise<TicketPlan | null> {
    const planPath = join(ticketDir, 'plan.md');
    try {
      const content = await readFile(planPath, 'utf-8');
      return { content, version: parsePlanVersion(content) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.warn(`[TicketBackend] Failed to read plan.md at ${planPath}:`, err);
      return null;
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
      maxChildren?: number;
      estimatedComplexity?: 'trivial' | 'low' | 'medium' | 'high';
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
        maxChildren: typeof body.maxChildren === 'number' && body.maxChildren > 0 ? body.maxChildren : undefined,
        estimatedComplexity: body.estimatedComplexity || undefined,
      },
      body: body.body ?? '',
    };

    await this.writeTicket(ticket);
    return jsonResponse(ticket, 201);
  }

  /**
   * Allocate a unique ticket id from a title. Format: `YYYY-MM-DD-<slug>`,
   * with `-2` / `-3` / ... suffix on collision. Uniqueness is checked
   * **across all project buckets** so an id can move between buckets later
   * (PUT changing project) without colliding.
   */
  private async allocateId(title: string): Promise<string> {
    const datePrefix = new Date().toISOString().slice(0, 10);
    const slug = slugify(title);
    const base = `${datePrefix}-${slug}`;
    let candidate = base;
    let n = 1;
    while (idTaken(this.ticketsDir, candidate)) {
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
      maxChildren?: number | null;
      estimatedComplexity?: 'trivial' | 'low' | 'medium' | 'high' | null;
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
    const positiveInt = (v: number): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

    const validComplexity = (v: string | null | undefined): 'trivial' | 'low' | 'medium' | 'high' | undefined => {
      if (v === null || v === undefined) return undefined;
      if (['trivial', 'low', 'medium', 'high'].includes(v)) return v as 'trivial' | 'low' | 'medium' | 'high';
      return undefined;
    };

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
        maxChildren: patchField(patch.maxChildren, existing.frontmatter.maxChildren, positiveInt),
        estimatedComplexity: validComplexity(patch.estimatedComplexity ?? null),
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
    const id = idMatch[1];
    if (!isValidTicketId(id)) return errorResponse('Invalid ticket id', 400);

    const dir = findTicketDir(this.ticketsDir, id);
    if (!dir) return errorResponse('Ticket not found', 404);

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
   * Persist a ticket. Path is derived from `frontmatter.project` →
   * `<ticketsDir>/<bucket>/<id>/ticket.md`.
   *
   * If the ticket already exists in a different bucket (PUT changed
   * `project`), the entire `<id>/` directory is renamed across buckets so
   * sibling artifacts (`plan.md`, `plan-v*.md`, `results/`) move with the
   * ticket. Renaming a directory is atomic on POSIX, so a crash mid-move
   * leaves the ticket either fully at the old or fully at the new path —
   * never split.
   */
  private async writeTicket(ticket: Ticket): Promise<void> {
    if (!isValidTicketId(ticket.id)) {
      throw new Error(`Invalid ticket id: ${ticket.id}`);
    }
    const targetDir = ticketDirForCreate(this.ticketsDir, ticket.frontmatter.project, ticket.id);
    const existingDir = findTicketDir(this.ticketsDir, ticket.id);

    if (existingDir && existingDir !== targetDir) {
      // Bucket change — move the directory before rewriting ticket.md so
      // a concurrent reader never sees the file at neither location.
      mkdirSync(dirname(targetDir), { recursive: true });
      await rename(existingDir, targetDir);
      logger.info(
        `[TicketBackend] Moved ${ticket.id} → ${bucketForProject(ticket.frontmatter.project)}/ (project changed)`,
      );
    } else if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const content = serializeTicket(ticket);
    await writeFile(join(targetDir, 'ticket.md'), content, 'utf-8');
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

  // Phase 3: maxChildren parses as a positive integer; non-numeric / zero /
  // negative values fall back to undefined. Only meaningful when the ticket's
  // template is planner-role; otherwise ignored at dispatch time.
  //
  // `usePlanner` is an obsolete field — planner vs executor is now derived
  // from the selected template's `role`. Any leftover value on disk is
  // silently dropped on the next save.
  const rawMaxChildren = fm.maxChildren ? Number.parseInt(fm.maxChildren, 10) : NaN;
  const maxChildren = Number.isFinite(rawMaxChildren) && rawMaxChildren > 0 ? rawMaxChildren : undefined;

  // estimatedComplexity: one of the four known values, or undefined if absent/malformed.
  const rawComplexity = fm.estimatedComplexity?.toLowerCase();
  const estimatedComplexity =
    rawComplexity && ['trivial', 'low', 'medium', 'high'].includes(rawComplexity)
      ? (rawComplexity as 'trivial' | 'low' | 'medium' | 'high')
      : undefined;

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
    maxChildren,
    estimatedComplexity,
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
  if (fm.maxChildren) lines.push(`maxChildren: ${fm.maxChildren}`);
  if (fm.estimatedComplexity) lines.push(`estimatedComplexity: ${fm.estimatedComplexity}`);
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
 * Pull the `plan_version` integer out of a plan.md frontmatter block, if
 * present. Returns undefined when there's no frontmatter, the field is
 * missing, or the value isn't a positive integer. Only scans the first
 * `---`-fenced block, so arbitrary body content can't inject a version.
 *
 * This parser is deliberately tiny (no YAML dep, no reuse of
 * `parseMarkdownTicket` which is ticket-specific). Plan frontmatter
 * follows a different schema (see `prompts/cluster/plan-schema.md`) and
 * we only need this one field right now — the rest stays as prose.
 */
function parsePlanVersion(content: string): number | undefined {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const vMatch = match[1].match(/^plan_version:\s*(\d+)\s*$/m);
  if (!vMatch) return undefined;
  const v = Number.parseInt(vMatch[1], 10);
  return Number.isFinite(v) && v > 0 ? v : undefined;
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

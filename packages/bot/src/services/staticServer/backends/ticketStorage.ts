/**
 * Filesystem helpers for the ticket storage layout.
 *
 * Layout (under the configured tickets directory):
 *   <ticketsDir>/
 *     .templates/                 — body skeletons + future scaffolding
 *     <projectBucket>/<id>/       — tickets bucketed by their `project` field
 *     _unassigned/<id>/           — tickets with no `project` set
 *
 * The bucket layer was added in 2026-04-16 batch4 to keep the per-project
 * ticket count tractable at the filesystem level. Before that, all tickets
 * lived flat under `<ticketsDir>/<id>/`; a one-shot migration in
 * `TicketBackend` constructor moves any leftover flat-layout entries into
 * their project bucket on startup.
 *
 * `id` is globally unique across all buckets — POST allocates a fresh id
 * by checking every bucket for a collision. Looking a ticket up by id
 * therefore requires scanning bucket dirs, which `findTicketDir` does.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Bucket name for tickets whose `project` frontmatter is empty. */
export const UNASSIGNED_BUCKET = '_unassigned';

/** Reserved entries at the tickets-dir root that are NOT project buckets. */
const RESERVED_ENTRIES = new Set<string>(['.templates']);

/**
 * Map a ticket's `project` frontmatter value to its on-disk bucket name.
 * Empty / whitespace-only / undefined → `_unassigned`. Project values
 * containing path separators are coerced into a flat name so a hostile
 * frontmatter can't escape the tickets root.
 */
export function bucketForProject(project: string | undefined | null): string {
  const trimmed = project?.trim();
  if (!trimmed) return UNASSIGNED_BUCKET;
  // Collapse anything that looks like a path separator. Project aliases in
  // practice are kebab-case ASCII (`qqbot`, `video-knowledge-backend`) — this
  // is purely a defensive sanitization for the edge case of a ticket
  // smuggling `..` or `/` into its project field via direct file edit.
  return trimmed.replace(/[/\\]/g, '_');
}

/** Validate a ticket id matches the expected `<date>-<slug>` shape. */
export function isValidTicketId(id: string): boolean {
  if (!id) return false;
  if (id.includes('/') || id.includes('\\')) return false;
  if (id.startsWith('.') || id.endsWith('.md')) return false;
  return true;
}

/**
 * Compute the absolute directory path for a NEW ticket. Caller is
 * responsible for ensuring the id is unique (see `idTaken`).
 */
export function ticketDirForCreate(ticketsDir: string, project: string | undefined, id: string): string {
  return join(ticketsDir, bucketForProject(project), id);
}

/**
 * Locate an existing ticket by id. Scans every bucket subdirectory of
 * `ticketsDir` looking for one that contains `<id>/ticket.md`. Returns
 * the absolute path to the ticket directory (i.e. the parent of
 * `ticket.md`), or null if no bucket holds it.
 *
 * Reserved entries (`.templates`, dotfiles like `.git`, plain files like
 * `README.md`) are skipped. Hidden buckets — anything starting with `.` —
 * are NEVER treated as project buckets.
 *
 * Linear scan over buckets. Cheap for the realistic ticket-count range
 * (dozens to low hundreds across <50 buckets); if this ever shows up as
 * a hot path, swap in an in-memory id→bucket map maintained by writes.
 */
export function findTicketDir(ticketsDir: string, id: string): string | null {
  if (!isValidTicketId(id)) return null;
  let entries: string[];
  try {
    entries = readdirSync(ticketsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (RESERVED_ENTRIES.has(entry)) continue;
    const bucketPath = join(ticketsDir, entry);
    try {
      if (!statSync(bucketPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const ticketPath = join(bucketPath, id);
    if (existsSync(join(ticketPath, 'ticket.md'))) {
      return ticketPath;
    }
  }
  return null;
}

/**
 * Iterator over every (bucket, ticketId, ticketDir) triple in the tickets
 * root. Used by `listAll()` and the startup migration. Skips reserved /
 * hidden entries at the root and entries that don't contain `ticket.md`.
 */
export function* iterateAllTickets(ticketsDir: string): Generator<{ bucket: string; id: string; ticketDir: string }> {
  let buckets: string[];
  try {
    buckets = readdirSync(ticketsDir);
  } catch {
    return;
  }
  for (const bucket of buckets) {
    if (bucket.startsWith('.')) continue;
    if (RESERVED_ENTRIES.has(bucket)) continue;
    const bucketPath = join(ticketsDir, bucket);
    let bucketStat: ReturnType<typeof statSync>;
    try {
      bucketStat = statSync(bucketPath);
    } catch {
      continue;
    }
    if (!bucketStat.isDirectory()) continue;
    let inner: string[];
    try {
      inner = readdirSync(bucketPath);
    } catch {
      continue;
    }
    for (const id of inner) {
      if (!isValidTicketId(id)) continue;
      const ticketDir = join(bucketPath, id);
      try {
        if (!statSync(ticketDir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(ticketDir, 'ticket.md'))) continue;
      yield { bucket, id, ticketDir };
    }
  }
}

/**
 * Check whether a ticket id is already taken anywhere in the tickets root.
 * Used by id allocation to enforce global uniqueness (POST disambiguates
 * with `-2 / -3` suffixes when a same-day same-slug collision happens
 * across any bucket).
 */
export function idTaken(ticketsDir: string, id: string): boolean {
  return findTicketDir(ticketsDir, id) !== null;
}

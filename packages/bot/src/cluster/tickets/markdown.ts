/**
 * The on-disk markdown format of a ticket: `---` frontmatter plus a body.
 *
 * Hand-rolled rather than gray-matter: the format is flat `key: value` pairs, and the
 * writer must emit a stable key order so file diffs stay clean across edits.
 */

import type { Ticket, TicketFrontmatter, TicketStatus } from '@qqbot/api-types';

/** Every status a ticket may carry on disk; anything else parses back as `draft`. */
export const ALLOWED_STATUSES: readonly TicketStatus[] = ['draft', 'ready', 'dispatched', 'done', 'abandoned'];

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
export function parsePlanVersion(content: string): number | undefined {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const vMatch = match[1].match(/^plan_version:\s*(\d+)\s*$/m);
  if (!vMatch) return undefined;
  const v = Number.parseInt(vMatch[1], 10);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

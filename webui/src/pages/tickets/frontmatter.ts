import type { TicketStatus } from '../../types';

const ALLOWED_STATUSES: TicketStatus[] = ['draft', 'ready', 'dispatched', 'done', 'abandoned'];
const ALLOWED_COMPLEXITY = ['trivial', 'low', 'medium', 'high'] as const;

export interface ExtractedFrontmatter {
  title?: string;
  status?: TicketStatus;
  template?: string;
  project?: string;
  usePlanner?: boolean;
  maxChildren?: number;
  estimatedComplexity?: (typeof ALLOWED_COMPLEXITY)[number];
}

export interface ExtractResult {
  frontmatter: ExtractedFrontmatter;
  body: string;
}

/**
 * Mirrors the backend `parseMarkdownTicket` in TicketBackend.ts — flat
 * `key: value` YAML block delimited by `---`. Returns null when the
 * body doesn't start with a frontmatter block, so callers can leave
 * the body untouched.
 *
 * Only lifts fields that map to TicketEditor form controls; id/created/
 * updated/dispatchedJobId are backend-managed and ignored on purpose.
 */
export function extractFrontmatter(raw: string): ExtractResult | null {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  let endLine = -1;
  const fm: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endLine = i;
      break;
    }
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key) fm[key] = value;
    }
  }
  if (endLine === -1) return null;

  const body = lines
    .slice(endLine + 1)
    .join('\n')
    .replace(/^\n+/, '');

  const out: ExtractedFrontmatter = {};
  if (fm.title) out.title = fm.title;
  if (fm.status && ALLOWED_STATUSES.includes(fm.status as TicketStatus)) {
    out.status = fm.status as TicketStatus;
  }
  if (fm.template) out.template = fm.template;
  if (fm.project) out.project = fm.project;
  if (fm.usePlanner?.toLowerCase() === 'true') out.usePlanner = true;
  const n = fm.maxChildren ? Number.parseInt(fm.maxChildren, 10) : NaN;
  if (Number.isFinite(n) && n > 0) out.maxChildren = n;
  const c = fm.estimatedComplexity?.toLowerCase();
  if (c && (ALLOWED_COMPLEXITY as readonly string[]).includes(c)) {
    out.estimatedComplexity = c as (typeof ALLOWED_COMPLEXITY)[number];
  }

  return { frontmatter: out, body };
}

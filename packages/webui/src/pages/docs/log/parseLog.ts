/**
 * Parser for FileLogger output (`logs/**.log`). Each entry starts at a
 * `[YYYY-MM-DD HH:mm:ss] [LEVEL] ` line; every following line without that
 * header belongs to it (meta JSON, stack traces, dumped prompts). Files
 * written by other producers (pm2 stdout in `logs/webui.log`) have no headers
 * at all, so a header-less line stands as its own entry instead of being
 * folded into the previous one.
 *
 * An entry written with `formatLogSections()` (packages/bot/src/utils/logger.ts)
 * carries `── [label] ──` marker lines in its body; each marker opens a
 * section so the viewer can fold the parts one by one.
 */

const HEADER = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([A-Za-z]+)\] ?/;
const LEADING_TAG = /^\[([^[\]\n]{1,48})\]\s*/;
const SECTION_MARKER = /^── \[(.+)\] ──$/;
const MAX_TAGS = 3;

export interface LogSection {
  /** `null` for body lines that sit before any section marker, i.e. a plain multi-line body. */
  label: string | null;
  lines: string[];
}

export interface LogEntry {
  time: string | null;
  level: string | null;
  /** Leading `[Scope]` groups of the message, e.g. `[12345] [ReplySystem]`. */
  tags: string[];
  message: string;
  sections: LogSection[];
  /** Lowercased entry text, precomputed so filtering stays cheap on 40k-line files. */
  haystack: string;
}

export interface LogFile {
  entries: LogEntry[];
  levels: Array<{ level: string; count: number }>;
}

function splitTags(rest: string): { tags: string[]; message: string } {
  const tags: string[] = [];
  let message = rest;
  while (tags.length < MAX_TAGS) {
    const m = LEADING_TAG.exec(message);
    if (!m) {
      break;
    }
    tags.push(m[1]);
    message = message.slice(m[0].length);
  }
  return { tags, message };
}

function appendBodyLine(entry: LogEntry, line: string): void {
  const marker = SECTION_MARKER.exec(line);
  if (marker) {
    entry.sections.push({ label: marker[1], lines: [] });
    return;
  }
  const last = entry.sections[entry.sections.length - 1];
  if (last) {
    last.lines.push(line);
  } else {
    entry.sections.push({ label: null, lines: [line] });
  }
}

export function parseLog(raw: string): LogFile {
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const entries: LogEntry[] = [];
  const counts = new Map<string, number>();
  let open: LogEntry | null = null;

  for (const line of lines) {
    const m = HEADER.exec(line);
    if (m) {
      const level = m[2].toUpperCase();
      counts.set(level, (counts.get(level) ?? 0) + 1);
      open = {
        time: m[1],
        level,
        ...splitTags(line.slice(m[0].length)),
        sections: [],
        haystack: '',
      };
      entries.push(open);
      continue;
    }
    if (open) {
      appendBodyLine(open, line);
      continue;
    }
    entries.push({ time: null, level: null, tags: [], message: line, sections: [], haystack: '' });
  }

  for (const e of entries) {
    const body = e.sections.flatMap((s) => (s.label === null ? s.lines : [s.label, ...s.lines]));
    e.haystack = [...e.tags, e.message, ...body].join('\n').toLowerCase();
  }

  const levels = [...counts.entries()]
    .map(([level, count]) => ({ level, count }))
    .sort((a, b) => a.level.localeCompare(b.level));

  return { entries, levels };
}

/**
 * Parser for FileLogger output (`logs/**.log`). Each entry starts at a
 * `[YYYY-MM-DD HH:mm:ss] [LEVEL] ` line; every following line without that
 * header belongs to it (meta JSON, stack traces, dumped prompts). Files
 * written by other producers (pm2 stdout in `logs/webui.log`) have no headers
 * at all, so a header-less line stands as its own entry instead of being
 * folded into the previous one.
 */

const HEADER = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([A-Za-z]+)\] ?/;
const LEADING_TAG = /^\[([^[\]\n]{1,48})\]\s*/;
const MAX_TAGS = 3;

export interface LogEntry {
  time: string | null;
  level: string | null;
  /** Leading `[Scope]` groups of the message, e.g. `[12345] [ReplySystem]`. */
  tags: string[];
  message: string;
  body: string[];
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
        body: [],
        haystack: '',
      };
      entries.push(open);
      continue;
    }
    if (open) {
      open.body.push(line);
      continue;
    }
    entries.push({ time: null, level: null, tags: [], message: line, body: [], haystack: '' });
  }

  for (const e of entries) {
    e.haystack = [...e.tags, e.message, ...e.body].join('\n').toLowerCase();
  }

  const levels = [...counts.entries()]
    .map(([level, count]) => ({ level, count }))
    .sort((a, b) => a.level.localeCompare(b.level));

  return { entries, levels };
}

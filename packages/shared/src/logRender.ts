// How a log entry reads in a terminal. The log file holds plain text for its parsers (daily
// stats, the WebUI log page); the console and `bun run logs` both render that same text here, so
// what the bot prints and what a follower of its file shows cannot drift apart. Everything is
// derived from the text: a context tag's colour from the tag itself, which is all the file keeps.

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GRAY = `${ESC}90m`;
const WHITE = `${ESC}97m`;

const LEVEL_STYLE: Record<string, { badge: string; body: string }> = {
  DEBUG: { badge: GRAY, body: GRAY },
  INFO: { badge: `${ESC}1;36m`, body: '' },
  WARN: { badge: `${ESC}1;33m`, body: `${ESC}33m` },
  ERROR: { badge: `${ESC}1;31m`, body: `${ESC}31m` },
};

/** Backgrounds for context tags (cyan, green, yellow, blue, magenta): the text on them stays white. */
const TAG_BACKGROUNDS = ['46', '42', '43', '44', '45'] as const;

/** Foregrounds for module tags; a module keeps its colour across lines, runs and processes. */
const MODULE_COLORS = ['34', '35', '32', '36', '33', '94', '95', '92', '96'] as const;

function hash(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    n = (n * 31 + text.charCodeAt(i)) >>> 0;
  }
  return n;
}

/** The background a context tag such as `msg:ab12cd` is painted with, as an SGR code. */
export function logTagBackground(tag: string): string {
  return TAG_BACKGROUNDS[hash(tag) % TAG_BACKGROUNDS.length];
}

/** `[2026-11-15 17:55:50] [INFO] [msg:ab12cd] [Module] message`: what both transports write. */
const ENTRY =
  /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] \[(DEBUG|INFO|WARN|ERROR)\] (?:\[(msg:[^\]\s]+)\] )?(?:\[([A-Za-z][\w.:/-]*)\] )?/;
/** A `── [label] ──` part marker of a multi-part entry (`formatLogSections`). */
const SECTION = /^── \[.+\] ──$/;
/** Where a continuation line starts: under the message, past `HH:mm:ss LEVEL `. */
const GUTTER = ' '.repeat(15);
const MAX_SEEN_TAGS = 2000;
/** Marks the lines daily stats parses; not a module, so it is dimmed rather than coloured. */
const PARSER_MARKER = 'STATS';

/**
 * Renders log text one entry at a time. It keeps two facts between entries: the date of the last
 * one, to print a separator when the day changes, and the context tags already seen, so the first
 * line of each context is set off on its tag's background across the whole line.
 */
export class LogLineRenderer {
  private lastDate = '';
  private readonly seenTags = new Set<string>();

  /** One entry: its first line, and the stack, meta or parts on the lines after it. */
  render(text: string): string {
    const [first, ...rest] = text.split('\n');
    const head = ENTRY.exec(first);
    if (!head) {
      return text.split('\n').map(continuation).join('\n');
    }
    const [matched, date, time, level, tag, module] = head;
    const style = LEVEL_STYLE[level];
    const body = first.slice(matched.length);
    const lines: string[] = [];
    if (date !== this.lastDate) {
      this.lastDate = date;
      lines.push(`${DIM}──────── ${date} ────────${RESET}`);
    }

    const timePart = `${DIM}${time}${RESET}`;
    const levelPart = `${style.badge}${level.padEnd(5)}${RESET}`;
    if (tag && this.firstSight(tag)) {
      const plain = [module ? `[${module}]` : '', body].filter(Boolean).join(' ');
      lines.push(`${timePart} ${levelPart} ${ESC}${logTagBackground(tag)};97m [${tag}] ${plain} ${RESET}`);
    } else {
      const parts = [timePart, levelPart];
      if (tag) {
        parts.push(`${ESC}${logTagBackground(tag)}m${WHITE}[${tag}]${RESET}`);
      }
      if (module === PARSER_MARKER) {
        parts.push(`${DIM}[${module}]${RESET}`);
      } else if (module) {
        parts.push(`${ESC}${MODULE_COLORS[hash(module) % MODULE_COLORS.length]}m${module}${RESET}`);
      }
      parts.push(styleBody(body, style.body));
      lines.push(parts.join(' '));
    }
    for (const line of rest) {
      lines.push(continuation(line));
    }
    return lines.join('\n');
  }

  private firstSight(tag: string): boolean {
    if (this.seenTags.has(tag)) {
      return false;
    }
    if (this.seenTags.size >= MAX_SEEN_TAGS) {
      this.seenTags.clear();
    }
    this.seenTags.add(tag);
    return true;
  }
}

/** Parser markers (`[STATS]`, `====>`) dimmed; the rest in the level's colour. */
function styleBody(body: string, color: string): string {
  const marked = body
    .replace(/\[STATS\] ?/g, `${DIM}[STATS]${RESET}${color} `)
    .replace(/={3,}>/g, (arrow) => `${DIM}${arrow}${RESET}${color}`);
  return color ? `${color}${marked}${RESET}` : marked;
}

function continuation(line: string): string {
  if (SECTION.test(line.trim())) {
    return `${GUTTER}${BOLD}${line.trim()}${RESET}`;
  }
  return `${GUTTER}${GRAY}${line}${RESET}`;
}

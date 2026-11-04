import { logLines } from './logs';

export type TranscriptKind = 'text' | 'tool' | 'result' | 'reasoning' | 'raw';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptKind;
  /** Epoch ms when the event carried a time of its own; absent otherwise — never invented. */
  at?: number;
  /** The one line shown collapsed. */
  title: string;
  /** The full text, shown for `text` / `result` and on expanding a `tool`. */
  body?: string;
  /** A tool call that failed, so the row can be marked. */
  failed?: boolean;
}

type Json = Record<string, unknown>;

const TITLE_MAX = 160;
const ARG_MAX = 80;
const MIN_EVENT_SHARE = 1 / 3;
const REPO_ANCHORS = ['packages', 'src', 'docs', 'scripts', 'prompts', 'tests', 'apps'];

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? '';
}

function shortenPath(path: string): string {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    return path;
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  const anchor = parts.findIndex((part, index) => index < parts.length - 1 && REPO_ANCHORS.includes(part));
  return (anchor >= 0 ? parts.slice(anchor) : parts.slice(-2)).join('/');
}

/** "读取 src/app/Shell.tsx" / "执行 bash: bun test …" — one readable line per tool call. */
export function toolTitle(name: string, input: unknown): string {
  const args = asRecord(input) ?? {};
  const arg = (key: string): string | undefined => {
    const value = asString(args[key]);
    return value ? value : undefined;
  };
  const path = (): string | undefined => {
    const value = arg('file_path');
    return value === undefined ? undefined : shortenPath(value);
  };
  const withArg = (label: string, value: string | undefined): string =>
    value === undefined ? label.trimEnd() : `${label}${clip(firstLine(value), ARG_MAX)}`;

  switch (name) {
    case 'Read':
      return withArg('读取 ', path());
    case 'Write':
      return withArg('写入 ', path());
    case 'Edit':
      return withArg('编辑 ', path());
    case 'Bash':
      return withArg('执行 bash: ', arg('command'));
    case 'Grep':
      return withArg('搜索 ', arg('pattern'));
    case 'Glob':
      return withArg('查找 ', arg('pattern'));
    case 'Task':
      return withArg('派子 agent: ', arg('description'));
    case 'TodoWrite':
      return '更新任务清单';
    case 'WebFetch':
      return withArg('抓取 ', arg('url'));
    case 'WebSearch':
      return withArg('搜索网页 ', arg('query'));
    default:
      return name.startsWith('mcp__') ? `调用 ${name.slice('mcp__'.length).replaceAll('__', ' · ')}` : `调用 ${name}`;
  }
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) && Math.abs(value) < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function eventTime(event: Json): number | undefined {
  for (const key of ['timestamp', 'created_at', 'time']) {
    const at = toEpochMs(event[key]);
    if (at !== undefined) {
      return at;
    }
  }
  return undefined;
}

function blockText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content.flatMap((block) => {
      const text = asString(asRecord(block)?.text);
      return text === undefined ? [] : [text];
    });
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

type Draft = Omit<TranscriptEntry, 'id' | 'at'>;

function rawDraft(line: string): Draft {
  return { kind: 'raw', title: clip(line, TITLE_MAX), body: line };
}

function textDraft(text: string): Draft {
  return { kind: 'text', title: clip(firstLine(text), TITLE_MAX), body: text };
}

function claudeDrafts(event: Json, type: string): Draft[] {
  if (type === 'result') {
    return [{ kind: 'result', title: '最终答复', body: asString(event.result) ?? '' }];
  }
  if (type === 'system') {
    return [];
  }

  const content = asRecord(event.message)?.content;
  if (typeof content === 'string') {
    return type === 'assistant' && content.trim() !== '' ? [textDraft(content)] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const drafts: Draft[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (!block) {
      continue;
    }
    if (type === 'assistant') {
      if (block.type === 'text') {
        const text = asString(block.text);
        if (text !== undefined && text.trim() !== '') {
          drafts.push(textDraft(text));
        }
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const thinking = asString(block.thinking) ?? '';
        const gist = firstLine(thinking);
        drafts.push({
          kind: 'reasoning',
          title: clip(gist ? `思考 · ${gist}` : '思考', TITLE_MAX),
          body: thinking || undefined,
        });
      } else if (block.type === 'tool_use') {
        drafts.push({
          kind: 'tool',
          title: toolTitle(asString(block.name) ?? 'unknown', block.input),
          body: JSON.stringify(block.input ?? {}, null, 2),
        });
      }
    } else if (type === 'user' && block.type === 'tool_result') {
      const text = blockText(block.content) ?? '';
      const gist = firstLine(text);
      drafts.push({
        kind: 'tool',
        title: `结果 · ${gist ? clip(gist, ARG_MAX) : '（空）'}`,
        body: text || undefined,
        failed: block.is_error === true,
      });
    }
  }
  return drafts;
}

function codexItemDraft(item: Json, line: string): Draft {
  const itemType = asString(item.type) ?? asString(item.item_type);
  const text = blockText(item.text) ?? blockText(item.content) ?? blockText(item.message);

  switch (itemType) {
    case 'agent_message':
    case 'assistant_message':
      return text !== undefined && text.trim() !== '' ? textDraft(text) : rawDraft(line);
    case 'reasoning': {
      const thought = text ?? blockText(item.summary);
      return thought === undefined
        ? rawDraft(line)
        : { kind: 'reasoning', title: clip(`思考 · ${firstLine(thought)}`, TITLE_MAX), body: thought };
    }
    case 'command_execution': {
      const command = asString(item.command);
      if (command === undefined) {
        return rawDraft(line);
      }
      const exitCode = item.exit_code;
      return {
        kind: 'tool',
        title: toolTitle('Bash', { command }),
        body: asString(item.aggregated_output) ?? asString(item.output),
        failed: item.status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0),
      };
    }
    case 'tool_call':
    case 'mcp_tool_call': {
      const tool = asString(item.tool) ?? asString(item.name);
      if (tool === undefined) {
        return rawDraft(line);
      }
      const server = asString(item.server);
      const args = item.arguments ?? item.input;
      const detail = item.result ?? item.output ?? item.error ?? args;
      return {
        kind: 'tool',
        title: toolTitle(server ? `mcp__${server}__${tool}` : tool, args),
        body: detail === undefined ? undefined : (blockText(detail) ?? JSON.stringify(detail, null, 2)),
        failed: item.status === 'failed' || item.error !== undefined,
      };
    }
    default:
      return rawDraft(line);
  }
}

interface Parsed {
  drafts: Draft[];
  itemId?: string;
  at?: number;
}

function parseEvent(event: Json, type: string, line: string): Parsed {
  const at = eventTime(event);

  if (type === 'thread.started' || type === 'turn.started' || type === 'turn.completed') {
    return { drafts: [], at };
  }
  if (type === 'item.started' || type === 'item.completed') {
    const item = asRecord(event.item);
    if (!item) {
      return { drafts: [rawDraft(line)], at };
    }
    return { drafts: [codexItemDraft(item, line)], itemId: asString(item.id), at: at ?? eventTime(item) };
  }
  if (type === 'assistant' || type === 'user' || type === 'result' || type === 'system') {
    return { drafts: claudeDrafts(event, type), at };
  }
  return { drafts: [rawDraft(line)], at };
}

/** Parsed CLI events, in stream order; `null` when the output is not a known event stream. */
export function parseTranscript(raw: string): TranscriptEntry[] | null {
  const lines = logLines(raw);
  if (lines.length === 0) {
    return null;
  }

  const entries: TranscriptEntry[] = [];
  // codex emits `item.started` then `item.completed` for one item; the later event replaces the earlier row.
  const itemSlots = new Map<string, number>();
  let events = 0;

  lines.forEach((line, index) => {
    let event: Json | undefined;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      event = undefined;
    }
    const type = event ? asString(event.type) : undefined;

    if (!event || !type) {
      entries.push({ id: `t${index}`, ...rawDraft(line) });
      return;
    }
    events += 1;

    const { drafts, itemId, at } = parseEvent(event, type, line);
    drafts.forEach((draft, offset) => {
      const entry: TranscriptEntry = { id: offset === 0 ? `t${index}` : `t${index}.${offset}`, ...draft };
      if (at !== undefined) {
        entry.at = at;
      }
      const slot = itemId === undefined ? undefined : itemSlots.get(itemId);
      if (slot !== undefined) {
        entries[slot] = { ...entry, id: entries[slot]?.id ?? entry.id };
        return;
      }
      if (itemId !== undefined) {
        itemSlots.set(itemId, entries.length);
      }
      entries.push(entry);
    });
  });

  return events / lines.length < MIN_EVENT_SHARE ? null : entries;
}

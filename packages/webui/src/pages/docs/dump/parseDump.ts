/**
 * Parser for LLMDumpPlugin output (`logs/llm-dumps/**.md`). The format is
 * machine-generated and regular: one `##` header per LLM call, `###` sections
 * whose bodies live in backtick fences long enough that embedded fences can't
 * break out, and `==========`-ruled transcript entries inside `conversation`.
 * Structural lines are only recognized outside fences.
 */

export interface TranscriptMessage {
  role: string;
  speaker: string | null;
  time: string | null;
  body: string;
}

export interface DumpToolCall {
  name: string;
  id: string | null;
  args: string;
}

export type TextSectionRole = 'system' | 'prompt' | 'thinking' | 'output' | 'tool-result' | 'other';

export type DumpSection =
  | { kind: 'text'; role: TextSectionRole; label: string; body: string }
  | { kind: 'conversation'; label: string; messages: TranscriptMessage[] }
  | { kind: 'envelope'; label: string; parts: Array<{ tag: string; body: string }> }
  | { kind: 'tool-calls'; label: string; calls: DumpToolCall[] };

export interface DumpEntry {
  time: string;
  op: string;
  provider: string;
  model: string | null;
  sections: DumpSection[];
  stats: string[];
}

export interface DumpFile {
  title: string;
  raw: string;
  entries: DumpEntry[];
}

const TRANSCRIPT_RULE = '='.repeat(10);

export function isLLMDump(text: string): boolean {
  return text.startsWith('# LLM dump');
}

function textRoleFor(name: string): { role: TextSectionRole; label: string } {
  if (name === 'system' || name.startsWith('system #')) return { role: 'system', label: name };
  if (name === 'prompt') return { role: 'prompt', label: name };
  if (name === '⟵ thinking') return { role: 'thinking', label: 'thinking' };
  if (name === '⟵ output') return { role: 'output', label: 'output' };
  if (name.startsWith('tool ←')) return { role: 'tool-result', label: name };
  return { role: 'other', label: name };
}

function parseTranscriptHeader(header: string): TranscriptMessage {
  const m = header.match(/^(\S+)(?:\s+\[speaker:(.+?)\])?(?:\s+(\d{1,2}\/\d{1,2} \d{1,2}:\d{2}))?$/);
  if (!m) {
    return { role: header, speaker: null, time: null, body: '' };
  }
  return { role: m[1], speaker: m[2] ?? null, time: m[3] ?? null, body: '' };
}

function parseTranscript(body: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let current: TranscriptMessage | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) {
      current.body = buffer.join('\n').trim();
      messages.push(current);
    }
    buffer = [];
  };

  for (const line of body.split('\n')) {
    if (line.startsWith(`${TRANSCRIPT_RULE} `) && line.endsWith(` ${TRANSCRIPT_RULE}`)) {
      flush();
      current = parseTranscriptHeader(line.slice(TRANSCRIPT_RULE.length + 1, -(TRANSCRIPT_RULE.length + 1)));
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();
  return messages;
}

type Pending =
  | { type: 'text'; role: TextSectionRole; label: string }
  | { type: 'conversation' }
  | { type: 'envelope-part'; tag: string }
  | { type: 'tool-call' };

export function parseDump(raw: string): DumpFile {
  const lines = raw.split('\n');
  const title = lines[0]?.startsWith('# ') ? lines[0].slice(2) : 'LLM dump';

  const entries: DumpEntry[] = [];
  let entry: DumpEntry | null = null;
  let pending: Pending | null = null;
  let envelope: Extract<DumpSection, { kind: 'envelope' }> | null = null;
  let toolCalls: Extract<DumpSection, { kind: 'tool-calls' }> | null = null;

  let fenceTicks = 0;
  let fenceBody: string[] = [];

  const dispatchFence = (body: string) => {
    if (!entry || !pending) return;
    if (pending.type === 'text') {
      entry.sections.push({ kind: 'text', role: pending.role, label: pending.label, body });
    } else if (pending.type === 'conversation') {
      const messages = parseTranscript(body);
      if (messages.length > 0) {
        entry.sections.push({ kind: 'conversation', label: 'conversation', messages });
      } else {
        entry.sections.push({ kind: 'text', role: 'other', label: 'conversation', body });
      }
    } else if (pending.type === 'envelope-part') {
      envelope?.parts.push({ tag: pending.tag, body });
    } else if (pending.type === 'tool-call') {
      const call = toolCalls?.calls.at(-1);
      if (call) call.args = body;
    }
    pending = null;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (fenceTicks > 0) {
      if (/^`+$/.test(line) && line.length >= fenceTicks) {
        dispatchFence(fenceBody.join('\n'));
        fenceTicks = 0;
        fenceBody = [];
      } else {
        fenceBody.push(line);
      }
      continue;
    }

    const fenceOpen = line.match(/^(`{3,})\w*$/);
    if (fenceOpen) {
      fenceTicks = fenceOpen[1].length;
      continue;
    }

    if (line.startsWith('## ')) {
      const [time, op, provider, ...modelParts] = line.slice(3).split(' · ');
      entry = {
        time: time ?? '',
        op: op ?? '',
        provider: provider ?? '',
        model: modelParts.length > 0 ? modelParts.join(' · ') : null,
        sections: [],
        stats: [],
      };
      entries.push(entry);
      pending = null;
      envelope = null;
      toolCalls = null;
      continue;
    }
    if (!entry) continue;

    if (line.startsWith('### ')) {
      const name = line.slice(4);
      envelope = null;
      toolCalls = null;
      if (name === 'conversation') {
        pending = { type: 'conversation' };
      } else if (name === 'request envelope') {
        envelope = { kind: 'envelope', label: name, parts: [] };
        entry.sections.push(envelope);
        // The writer emits the envelope whole (no #### parts) when it can't split
        // it into <tag> sections; a following #### line just replaces this tag.
        pending = { type: 'envelope-part', tag: '(envelope)' };
      } else {
        pending = { type: 'text', ...textRoleFor(name) };
      }
      continue;
    }

    if (line.startsWith('#### ') && envelope) {
      pending = { type: 'envelope-part', tag: line.slice(5) };
      continue;
    }

    if (line === '**tool calls:**' || line === '**tool calls (response):**') {
      toolCalls = { kind: 'tool-calls', label: line.slice(2, -2), calls: [] };
      entry.sections.push(toolCalls);
      pending = null;
      continue;
    }

    const callItem = line.match(/^- `([^`]+)`(?: \((.+)\))?$/);
    if (callItem && toolCalls) {
      toolCalls.calls.push({ name: callItem[1], id: callItem[2] ?? null, args: '' });
      pending = { type: 'tool-call' };
      continue;
    }

    if (line === '_(no text)_' && pending?.type === 'text' && pending.role === 'output') {
      entry.sections.push({ kind: 'text', role: 'output', label: 'output', body: '' });
      pending = null;
      continue;
    }

    if (line.startsWith('> ')) {
      entry.stats = line.slice(2).split(' · ');
    }
  }

  // An unclosed fence at EOF (e.g. a dump truncated mid-write) still surfaces its content.
  if (fenceTicks > 0 && fenceBody.length > 0) {
    dispatchFence(fenceBody.join('\n'));
  }

  return { title, raw, entries };
}

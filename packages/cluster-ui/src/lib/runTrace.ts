import { shortenPath, type TranscriptEntry } from './transcript';

export type TraceStepKind = 'explore' | 'edit' | 'command' | 'test' | 'hub' | 'delegate' | 'message';

export interface TraceStep {
  id: string;
  kind: TraceStepKind;
  title: string;
  entryIds: string[];
  files: string[];
  count: number;
  failed: boolean;
}

export interface TracePhase {
  id: string;
  title: string;
  source: 'start' | 'report' | 'todo';
  steps: TraceStep[];
}

export interface TraceSegment {
  id: string;
  index: number;
  trigger: string | null;
  phases: TracePhase[];
}

export interface TraceFile {
  path: string;
  reads: number;
  edits: number;
  stepIds: string[];
}

export interface RunTrace {
  segments: TraceSegment[];
  files: TraceFile[];
  truncated: boolean;
}

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DELEGATE_TOOLS = new Set(['Task', 'Agent']);
const TEST_COMMAND = /\b(test|vitest|jest|typecheck|tsc|lint|biome|smoke-test)\b/;
const REPORT_TITLE_MAX = 60;
const PHASE_IN_PROGRESS = '进行中';

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? '';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function filePathOf(input: Json): string | undefined {
  const raw = asString(input.file_path) ?? asString(input.notebook_path);
  return raw === undefined ? undefined : shortenPath(raw);
}

function isHubTool(name: string): boolean {
  return /^mcp__.+__hub_/.test(name) || name.startsWith('hub_');
}

function isReportCall(name: string): boolean {
  return name === 'hub_report' || name.endsWith('__hub_report');
}

function hubToolName(name: string): string {
  return name.split('__').pop() ?? name;
}

function inProgressText(input: Json): string | undefined {
  if (!Array.isArray(input.todos)) {
    return undefined;
  }
  for (const todo of input.todos) {
    const row = asRecord(todo);
    if (row?.status !== 'in_progress') {
      continue;
    }
    const text = asString(row.content) ?? asString(row.activeForm);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function reportTitle(input: Json): string {
  const line = firstLine(asString(input.summary) ?? '');
  return line === '' ? '报告' : clip(line, REPORT_TITLE_MAX);
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

interface FileTally {
  reads: number;
  edits: number;
  stepIds: string[];
}

function noteFile(tally: Map<string, FileTally>, path: string, kind: 'read' | 'edit', stepId: string): void {
  const entry = tally.get(path) ?? { reads: 0, edits: 0, stepIds: [] };
  entry[kind === 'read' ? 'reads' : 'edits'] += 1;
  pushUnique(entry.stepIds, stepId);
  tally.set(path, entry);
}

type GroupType = 'explore' | 'edit' | 'message';

interface Group {
  type: GroupType;
  entries: TranscriptEntry[];
}

function stepIdOf(entry: TranscriptEntry): string {
  return `step:${entry.id}`;
}

function buildPhaseSteps(entries: TranscriptEntry[], tally: Map<string, FileTally>): TracePhase[] {
  const phases: TracePhase[] = [];
  let phaseId = `phase:${entries[0]?.id ?? '0'}`;
  let phaseTitle = '开始';
  let phaseSource: TracePhase['source'] = 'start';
  let phaseSteps: TraceStep[] = [];
  let pending: Group | null = null;
  let lastStep: TraceStep | undefined;
  let lastInProgress: string | undefined;
  const callSteps = new Map<string, TraceStep>();

  const flushPhase = () => {
    if (phaseSteps.length > 0) {
      phases.push({ id: phaseId, title: phaseTitle, source: phaseSource, steps: phaseSteps });
    }
  };

  const openPhase = (entryId: string, title: string, source: TracePhase['source']) => {
    flushPhase();
    phaseId = `phase:${entryId}`;
    phaseTitle = title;
    phaseSource = source;
    phaseSteps = [];
  };

  const closePhaseWithReport = (step: TraceStep, title: string) => {
    phaseTitle = title;
    phaseSource = 'report';
    flushPhase();
    phaseId = `phase:after:${step.id}`;
    phaseTitle = PHASE_IN_PROGRESS;
    phaseSource = 'start';
    phaseSteps = [];
  };

  const emit = (step: TraceStep) => {
    phaseSteps.push(step);
    lastStep = step;
  };

  const attach = (entry: TranscriptEntry) => {
    if (lastStep === undefined) {
      return;
    }
    lastStep.entryIds.push(entry.id);
    if (entry.failed === true) {
      lastStep.failed = true;
    }
  };

  const attachResult = (entry: TranscriptEntry) => {
    const target = (entry.resultOf === undefined ? undefined : callSteps.get(entry.resultOf)) ?? lastStep;
    if (target === undefined) {
      return;
    }
    target.entryIds.push(entry.id);
    if (entry.failed === true) {
      target.failed = true;
    }
  };

  const emitGroup = (group: Group) => {
    const first = group.entries[0];
    let reads = 0;
    let searches = 0;
    const files: string[] = [];

    for (const entry of group.entries) {
      const name = entry.call?.name ?? '';
      if (group.type === 'explore') {
        if (name === 'Read') {
          reads += 1;
        } else if (SEARCH_TOOLS.has(name)) {
          searches += 1;
        }
        if (name === 'Read') {
          const path = filePathOf(entry.call?.input ?? {});
          if (path !== undefined) {
            pushUnique(files, path);
          }
        }
      } else if (group.type === 'edit') {
        const path = filePathOf(entry.call?.input ?? {});
        if (path !== undefined) {
          pushUnique(files, path);
        }
      }
    }

    let title = first.title;
    if (group.type === 'explore') {
      const halves: string[] = [];
      if (reads > 0) {
        halves.push(`读 ${reads} 个文件`);
      }
      if (searches > 0) {
        halves.push(`搜索 ${searches} 次`);
      }
      title = halves.join(' · ');
    } else if (group.type === 'edit' && files.length > 0) {
      const names = files.map(basename);
      const shown = names.slice(0, 3).join('、');
      title = names.length > 3 ? `改 ${shown} 等 ${names.length} 个` : `改 ${shown}`;
    }

    const step: TraceStep = {
      id: stepIdOf(first),
      kind: group.type,
      title,
      entryIds: group.entries.map((entry) => entry.id),
      files,
      count: group.entries.filter((entry) => entry.call !== undefined).length,
      failed: group.entries.some((entry) => entry.failed === true),
    };
    for (const entry of group.entries) {
      if (entry.call?.id !== undefined) {
        callSteps.set(entry.call.id, step);
      }
      if (group.type === 'explore' && entry.call?.name === 'Read') {
        const path = filePathOf(entry.call.input);
        if (path !== undefined) {
          noteFile(tally, path, 'read', step.id);
        }
      } else if (group.type === 'edit') {
        const path = filePathOf(entry.call?.input ?? {});
        if (path !== undefined) {
          noteFile(tally, path, 'edit', step.id);
        }
      }
    }
    emit(step);
  };

  const flushPending = () => {
    if (pending !== null) {
      const group = pending;
      pending = null;
      emitGroup(group);
    }
  };

  const startGroup = (type: GroupType, entry: TranscriptEntry) => {
    if (pending !== null && pending.type !== type) {
      flushPending();
    }
    if (pending === null) {
      pending = { type, entries: [] };
    }
    pending.entries.push(entry);
  };

  for (const entry of entries) {
    if (entry.kind === 'session') {
      flushPending();
      continue;
    }
    if (entry.resultOf !== undefined) {
      flushPending();
      attachResult(entry);
      continue;
    }
    if (entry.call !== undefined) {
      const { name, input } = entry.call;
      if (EXPLORE_TOOLS.has(name)) {
        startGroup('explore', entry);
        continue;
      }
      if (EDIT_TOOLS.has(name)) {
        startGroup('edit', entry);
        continue;
      }
      flushPending();
      if (name === 'Bash') {
        const kind: TraceStepKind = TEST_COMMAND.test(asString(input.command) ?? '') ? 'test' : 'command';
        const step: TraceStep = {
          id: stepIdOf(entry),
          kind,
          title: entry.title,
          entryIds: [entry.id],
          files: [],
          count: 1,
          failed: entry.failed === true,
        };
        if (entry.call.id !== undefined) {
          callSteps.set(entry.call.id, step);
        }
        emit(step);
        continue;
      }
      if (isHubTool(name)) {
        const tool = hubToolName(name);
        const status = asString(input.status);
        const step: TraceStep = {
          id: stepIdOf(entry),
          kind: 'hub',
          title: tool === 'hub_report' && status !== undefined ? `${tool} · ${status}` : tool,
          entryIds: [entry.id],
          files: [],
          count: 1,
          failed: entry.failed === true,
        };
        if (entry.call.id !== undefined) {
          callSteps.set(entry.call.id, step);
        }
        emit(step);
        if (isReportCall(name)) {
          closePhaseWithReport(step, reportTitle(input));
        }
        continue;
      }
      if (DELEGATE_TOOLS.has(name)) {
        const step: TraceStep = {
          id: stepIdOf(entry),
          kind: 'delegate',
          title: entry.title,
          entryIds: [entry.id],
          files: [],
          count: 1,
          failed: entry.failed === true,
        };
        if (entry.call.id !== undefined) {
          callSteps.set(entry.call.id, step);
        }
        emit(step);
        continue;
      }
      if (name === 'TodoWrite') {
        const text = inProgressText(input);
        if (text !== undefined && text !== lastInProgress) {
          lastInProgress = text;
          openPhase(entry.id, text, 'todo');
        }
        continue;
      }
      // A tool this trace has no step for: keep its row on the step it follows rather than lose it.
      attach(entry);
      continue;
    }
    if (entry.kind === 'text') {
      startGroup('message', entry);
      continue;
    }
    if (entry.kind === 'tool') {
      flushPending();
      attachResult(entry);
      continue;
    }
    flushPending();
    attach(entry);
  }

  flushPending();
  flushPhase();
  return phases;
}

/** Split a worker's transcript into one segment per process: the first run, then each resumed session. */
function splitSegments(entries: TranscriptEntry[]): TranscriptEntry[][] {
  const sessionStarts: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'session') {
      sessionStarts.push(index);
    }
  });
  if (sessionStarts.length <= 1) {
    return [entries];
  }
  const bounds = [0, ...sessionStarts.slice(1)];
  return bounds.map((start, index) => entries.slice(start, bounds[index + 1] ?? entries.length));
}

export function buildRunTrace(
  entries: TranscriptEntry[],
  opts: { truncated: boolean; resumes: Array<{ at: number; reason?: string }> },
): RunTrace {
  const tally = new Map<string, FileTally>();
  const segments: TraceSegment[] = splitSegments(entries).map((segmentEntries, index) => ({
    id: `segment:${segmentEntries[0]?.id ?? index}`,
    index,
    trigger: index === 0 ? null : (opts.resumes[index - 1]?.reason ?? null),
    phases: buildPhaseSteps(segmentEntries, tally),
  }));

  const files: TraceFile[] = [...tally.entries()]
    .map(([path, entry]) => ({
      path,
      reads: entry.reads,
      edits: entry.edits,
      stepIds: entry.stepIds,
    }))
    .sort((a, b) => {
      const editedA = a.edits > 0;
      const editedB = b.edits > 0;
      if (editedA !== editedB) {
        return editedA ? -1 : 1;
      }
      if (editedA && editedB) {
        return b.edits - a.edits || a.path.localeCompare(b.path);
      }
      return a.path.localeCompare(b.path);
    });

  return { segments, files, truncated: opts.truncated };
}

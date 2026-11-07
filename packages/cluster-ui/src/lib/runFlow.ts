import type { RunTrace, TraceStep } from './runTrace';

export const STEP_WIDTH = 232;
export const STEP_HEIGHT = 32;
export const MAX_STEPS_PER_PHASE = 40;
export const MAX_READ_ONLY_LISTED = 30;

const STEP_GAP = 8;
const PHASE_PAD = 10;
const PHASE_HEADER = 28;
const PHASE_GAP = 16;
const SEGMENT_PAD = 12;
const SEGMENT_HEADER = 32;
const SEGMENT_GAP = 48;
const FILE_COLUMN_GAP = 96;
const FILE_HEIGHT = 40;
const FILE_GAP = 8;
const EMPTY_BODY_HEIGHT = 24;

interface Placed {
  id: string;
  /** Relative to `parentId` when set, absolute otherwise. */
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
}

export type RunFlowNode =
  | (Placed & { type: 'segment'; label: string })
  | (Placed & { type: 'phase'; label: string })
  | (Placed & { type: 'step'; step: TraceStep })
  | (Placed & { type: 'more'; hidden: number })
  | (Placed & { type: 'file'; path: string; edits: number })
  | (Placed & { type: 'readonly'; paths: string[]; total: number });

export interface RunFlowEdge {
  id: string;
  source: string;
  target: string;
  kind: 'order' | 'edit';
}

export interface RunFlowLayout {
  nodes: RunFlowNode[];
  edges: RunFlowEdge[];
}

export function segmentLabel(index: number, trigger: string | null): string {
  return index === 0 ? '第 1 次运行' : `续用 #${index} · ${trigger ?? '被唤醒'}`;
}

/**
 * Segments left to right, phases left to right inside a segment, steps top to bottom inside a phase;
 * one `order` chain threads through every drawn step. Parents precede their children in `nodes`,
 * as React Flow requires. Steps beyond the phase cap fold into a single `more` node.
 */
export function layoutRunFlow(trace: RunTrace): RunFlowLayout {
  const nodes: RunFlowNode[] = [];
  const edges: RunFlowEdge[] = [];
  // Where the edit edges of a step start: the step itself, or the `more` node when the cap hid it.
  const anchorOf = new Map<string, string>();
  const stepKind = new Map<string, TraceStep['kind']>();
  let previousTail: string | null = null;
  let cursorX = 0;

  const chain = (head: string, tail: string) => {
    if (previousTail !== null) {
      edges.push({ id: `order:${previousTail}->${head}`, source: previousTail, target: head, kind: 'order' });
    }
    previousTail = tail;
  };

  for (const segment of trace.segments) {
    const phaseNodes: RunFlowNode[] = [];
    let phaseX = SEGMENT_PAD;
    let bodyHeight = 0;

    for (const phase of segment.phases) {
      if (phase.steps.length === 0) {
        continue;
      }
      const shown = phase.steps.slice(0, MAX_STEPS_PER_PHASE);
      const hidden = phase.steps.length - shown.length;
      const rows = shown.length + (hidden > 0 ? 1 : 0);
      const width = STEP_WIDTH + PHASE_PAD * 2;
      const height = PHASE_HEADER + rows * STEP_HEIGHT + (rows - 1) * STEP_GAP + PHASE_PAD * 2;
      const phaseId = `${segment.id}/${phase.id}`;
      phaseNodes.push({
        id: phaseId,
        type: 'phase',
        parentId: segment.id,
        label: phase.title,
        x: phaseX,
        y: SEGMENT_HEADER,
        width,
        height,
      });

      let head: string | null = null;
      let tail = '';
      const place = (id: string, row: number): Placed => ({
        id,
        parentId: phaseId,
        x: PHASE_PAD,
        y: PHASE_HEADER + PHASE_PAD + row * (STEP_HEIGHT + STEP_GAP),
        width: STEP_WIDTH,
        height: STEP_HEIGHT,
      });
      shown.forEach((step, row) => {
        const id = `step:${step.id}`;
        phaseNodes.push({ ...place(id, row), type: 'step', step });
        anchorOf.set(step.id, id);
        stepKind.set(step.id, step.kind);
        head ??= id;
        if (row > 0) {
          edges.push({ id: `order:${tail}->${id}`, source: tail, target: id, kind: 'order' });
        }
        tail = id;
      });
      if (hidden > 0) {
        const id = `more:${phaseId}`;
        phaseNodes.push({ ...place(id, shown.length), type: 'more', hidden });
        edges.push({ id: `order:${tail}->${id}`, source: tail, target: id, kind: 'order' });
        tail = id;
        for (const step of phase.steps.slice(MAX_STEPS_PER_PHASE)) {
          anchorOf.set(step.id, id);
          stepKind.set(step.id, step.kind);
        }
      }
      if (head !== null) {
        chain(head, tail);
      }
      phaseX += width + PHASE_GAP;
      bodyHeight = Math.max(bodyHeight, height);
    }

    const width = Math.max(phaseX - PHASE_GAP + SEGMENT_PAD, STEP_WIDTH + SEGMENT_PAD * 2);
    nodes.push({
      id: segment.id,
      type: 'segment',
      label: segmentLabel(segment.index, segment.trigger),
      x: cursorX,
      y: 0,
      width,
      height: SEGMENT_HEADER + (bodyHeight || EMPTY_BODY_HEIGHT) + SEGMENT_PAD,
    });
    nodes.push(...phaseNodes);
    cursorX += width + SEGMENT_GAP;
  }

  const fileX = cursorX - SEGMENT_GAP + FILE_COLUMN_GAP;
  const edited = trace.files.filter((file) => file.edits > 0);
  const readOnly = trace.files.filter((file) => file.edits === 0);
  let fileY = 0;
  for (const file of edited) {
    const id = `file:${file.path}`;
    nodes.push({
      id,
      type: 'file',
      path: file.path,
      edits: file.edits,
      x: fileX,
      y: fileY,
      width: STEP_WIDTH,
      height: FILE_HEIGHT,
    });
    fileY += FILE_HEIGHT + FILE_GAP;
    const sources = new Set<string>();
    for (const stepId of file.stepIds) {
      const anchor = anchorOf.get(stepId);
      if (anchor !== undefined && stepKind.get(stepId) === 'edit') {
        sources.add(anchor);
      }
    }
    for (const source of sources) {
      edges.push({ id: `edit:${source}->${id}`, source, target: id, kind: 'edit' });
    }
  }
  if (readOnly.length > 0) {
    nodes.push({
      id: 'files:read-only',
      type: 'readonly',
      paths: readOnly.slice(0, MAX_READ_ONLY_LISTED).map((file) => file.path),
      total: readOnly.length,
      x: fileX,
      y: fileY,
      width: STEP_WIDTH,
      height: FILE_HEIGHT,
    });
  }

  return { nodes, edges };
}

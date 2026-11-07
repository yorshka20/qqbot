import { describe, expect, test } from 'bun:test';
import { layoutRunFlow, MAX_READ_ONLY_LISTED, MAX_STEPS_PER_PHASE, segmentLabel } from './runFlow';
import type { RunTrace, TraceFile, TraceSegment, TraceStep } from './runTrace';

function step(id: string, patch: Partial<TraceStep> = {}): TraceStep {
  return { id, kind: 'explore', title: id, entryIds: [id], files: [], count: 1, failed: false, ...patch };
}

function segment(index: number, phases: Array<{ id: string; steps: TraceStep[] }>): TraceSegment {
  return {
    id: `seg${index}`,
    index,
    trigger: index === 0 ? null : 'directive',
    phases: phases.map((phase) => ({ ...phase, title: phase.id, source: 'start' as const })),
  };
}

const traceOf = (segments: TraceSegment[], files: TraceFile[] = []): RunTrace => ({ segments, files, truncated: false });

describe('layoutRunFlow', () => {
  test('one group per segment, phases nested in it and steps nested in their phase', () => {
    const { nodes } = layoutRunFlow(
      traceOf([
        segment(0, [{ id: 'p1', steps: [step('a'), step('b')] }, { id: 'p2', steps: [step('c')] }]),
        segment(1, [{ id: 'p3', steps: [step('d')] }]),
      ]),
    );
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(nodes.filter((n) => n.type === 'segment').map((n) => n.type === 'segment' && n.label)).toEqual([
      '第 1 次运行',
      '续用 #1 · directive',
    ]);
    expect(byId.get('seg0/p1')?.parentId).toBe('seg0');
    expect(byId.get('step:a')?.parentId).toBe('seg0/p1');
    expect(byId.get('step:d')?.parentId).toBe('seg1/p3');

    const seg0 = byId.get('seg0');
    const seg1 = byId.get('seg1');
    expect(seg1?.x).toBeGreaterThan((seg0?.x ?? 0) + (seg0?.width ?? 0));
    const phase = byId.get('seg0/p1');
    const second = byId.get('step:b');
    expect((second?.y ?? 0) + (second?.height ?? 0)).toBeLessThanOrEqual(phase?.height ?? 0);
    for (const node of nodes) {
      if (node.parentId) {
        expect(nodes.findIndex((n) => n.id === node.parentId)).toBeLessThan(nodes.indexOf(node));
      }
    }
  });

  test('an order chain threads every step, across phases and segments', () => {
    const { edges } = layoutRunFlow(
      traceOf([segment(0, [{ id: 'p1', steps: [step('a'), step('b')] }]), segment(1, [{ id: 'p2', steps: [step('c')] }])]),
    );
    expect(edges.filter((e) => e.kind === 'order').map((e) => [e.source, e.target])).toEqual([
      ['step:a', 'step:b'],
      ['step:b', 'step:c'],
    ]);
  });

  test('edited files get a node and an edge from each edit step; read-only files collapse', () => {
    const files: TraceFile[] = [
      { path: 'src/a.ts', reads: 1, edits: 2, stepIds: ['e1', 'e2', 'r1'] },
      ...Array.from({ length: 35 }, (_, i): TraceFile => ({ path: `docs/${i}.md`, reads: 1, edits: 0, stepIds: ['r1'] })),
    ];
    const { nodes, edges } = layoutRunFlow(
      traceOf(
        [
          segment(0, [
            {
              id: 'p',
              steps: [step('r1'), step('e1', { kind: 'edit' }), step('e2', { kind: 'edit' })],
            },
          ]),
        ],
        files,
      ),
    );
    expect(nodes.filter((n) => n.type === 'file')).toHaveLength(1);
    expect(edges.filter((e) => e.kind === 'edit').map((e) => e.source)).toEqual(['step:e1', 'step:e2']);
    const readOnly = nodes.find((n) => n.type === 'readonly');
    expect(readOnly?.type === 'readonly' && readOnly.total).toBe(35);
    expect(readOnly?.type === 'readonly' && readOnly.paths).toHaveLength(MAX_READ_ONLY_LISTED);
  });

  test('a phase past the cap folds the rest into one node that carries their edit edges', () => {
    const steps = Array.from({ length: MAX_STEPS_PER_PHASE + 5 }, (_, i) =>
      step(`s${i}`, i >= MAX_STEPS_PER_PHASE ? { kind: 'edit' } : {}),
    );
    const files: TraceFile[] = [{ path: 'x.ts', reads: 0, edits: 5, stepIds: steps.slice(MAX_STEPS_PER_PHASE).map((s) => s.id) }];
    const { nodes, edges } = layoutRunFlow(traceOf([segment(0, [{ id: 'p', steps }])], files));
    expect(nodes.filter((n) => n.type === 'step')).toHaveLength(MAX_STEPS_PER_PHASE);
    const more = nodes.find((n) => n.type === 'more');
    expect(more?.type === 'more' && more.hidden).toBe(5);
    expect(edges.filter((e) => e.kind === 'edit')).toEqual([
      { id: `edit:${more?.id}->file:x.ts`, source: more?.id ?? '', target: 'file:x.ts', kind: 'edit' },
    ]);
  });

  test('an empty trace has no nodes; empty phases are not drawn', () => {
    expect(layoutRunFlow(traceOf([])).nodes).toEqual([]);
    const { nodes } = layoutRunFlow(traceOf([segment(0, [{ id: 'p', steps: [] }])]));
    expect(nodes.map((n) => n.type)).toEqual(['segment']);
  });

  test('segment labels', () => {
    expect(segmentLabel(2, null)).toBe('续用 #2 · 被唤醒');
  });
});

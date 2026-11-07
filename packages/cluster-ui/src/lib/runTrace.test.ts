import { describe, expect, test } from 'bun:test';
import { buildRunTrace } from './runTrace';
import { parseTranscript } from './transcript';

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content } });

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  assistant({ type: 'tool_use', id, name, input });

const session = { type: 'system', subtype: 'init' };

function parse(raw: string) {
  const entries = parseTranscript(raw);
  if (entries === null) {
    throw new Error('fixture is not an event stream');
  }
  return entries;
}

function stepsOf(raw: string, opts = { truncated: false, resumes: [] as Array<{ at: number; reason?: string }> }) {
  return buildRunTrace(parse(raw), opts).segments.flatMap((segment) =>
    segment.phases.flatMap((phase) => phase.steps),
  );
}

describe('buildRunTrace folding', () => {
  test('folds consecutive explore calls into one step and counts reads and searches', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('u1', 'Read', { file_path: '/work/repo/src/a.ts' }),
          toolUse('u2', 'Read', { file_path: '/work/repo/src/b.ts' }),
          toolUse('u3', 'Grep', { pattern: 'useOutput' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    const steps = trace.segments[0]?.phases[0]?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      id: 'step:t0',
      kind: 'explore',
      title: '读 2 个文件 · 搜索 1 次',
      count: 3,
      failed: false,
    });
    expect(steps[0]?.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(steps[0]?.entryIds).toEqual(['t0', 't1', 't2']);
  });

  test('folds consecutive edits, names at most three files and counts every call', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('e1', 'Edit', { file_path: 'src/b.ts' }),
          toolUse('e2', 'Edit', { file_path: 'src/c.ts' }),
          toolUse('e3', 'Edit', { file_path: 'src/b.ts' }),
          toolUse('e4', 'Edit', { file_path: 'src/d.ts' }),
          toolUse('e5', 'Edit', { file_path: 'src/e.ts' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    const [step] = trace.segments[0]?.phases[0]?.steps ?? [];
    expect(step).toMatchObject({ kind: 'edit', title: '改 b.ts、c.ts、d.ts 等 4 个', count: 5 });
    expect(step?.files).toEqual(['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
  });

  test('starts a new explore step after an interleaved message', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
          assistant({ type: 'text', text: '先看一下' }),
          toolUse('u2', 'Read', { file_path: 'src/b.ts' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    expect(trace.segments[0]?.phases[0]?.steps.map((step) => step.kind)).toEqual([
      'explore',
      'message',
      'explore',
    ]);
  });
});

describe('buildRunTrace phases', () => {
  test('closes a phase on hub_report, taking its summary as the title', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          session,
          toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
          toolUse('h1', 'mcp__cluster-context-hub__hub_report', {
            status: 'working',
            summary: '看完了入口\n下一步改 Shell',
          }),
          toolUse('u2', 'Read', { file_path: 'src/b.ts' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    const phases = trace.segments[0]?.phases ?? [];
    expect(phases.map((phase) => phase.title)).toEqual(['看完了入口', '进行中']);
    expect(phases.map((phase) => phase.source)).toEqual(['report', 'start']);
    expect(phases[0]?.steps.at(-1)).toMatchObject({ kind: 'hub', title: 'hub_report · working' });
    expect(phases[1]?.steps.map((step) => step.kind)).toEqual(['explore']);
  });

  test('starts a phase on a TodoWrite in_progress item, and not on a repeated one', () => {
    const todo = (content: string) =>
      toolUse('t', 'TodoWrite', {
        todos: [
          { content, status: 'in_progress' },
          { content: '收尾', status: 'pending' },
        ],
      });

    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
          todo('实现 X'),
          toolUse('u2', 'Read', { file_path: 'src/b.ts' }),
          todo('实现 X'),
          todo('跑测试'),
          toolUse('u3', 'Read', { file_path: 'src/c.ts' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    const phases = trace.segments[0]?.phases ?? [];
    expect(phases.map((phase) => phase.title)).toEqual(['开始', '实现 X', '跑测试']);
    expect(phases.map((phase) => phase.source)).toEqual(['start', 'todo', 'todo']);
  });

  test('drops a phase that never got a step', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('t1', 'TodoWrite', { todos: [{ content: '只有一个', status: 'in_progress' }] }),
          toolUse('t2', 'TodoWrite', { todos: [{ content: '换一个', status: 'in_progress' }] }),
          toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    expect(trace.segments[0]?.phases.map((phase) => phase.title)).toEqual(['换一个']);
  });
});

describe('buildRunTrace segments', () => {
  test('splits on each resumed session and takes the resume reason as the trigger', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          session,
          toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
          session,
          toolUse('u2', 'Read', { file_path: 'src/b.ts' }),
        ),
      ),
      { truncated: true, resumes: [{ at: 1762243200000, reason: 'owner asked a question' }] },
    );

    expect(trace.segments.map((segment) => segment.index)).toEqual([0, 1]);
    expect(trace.segments.map((segment) => segment.trigger)).toEqual([null, 'owner asked a question']);
    expect(trace.segments[1]?.phases[0]?.steps.map((step) => step.kind)).toEqual(['explore']);
    expect(trace.truncated).toBe(true);
  });

  test('keeps entries before the first session marker in the first segment', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
          session,
          toolUse('u2', 'Read', { file_path: 'src/b.ts' }),
        ),
      ),
      { truncated: true, resumes: [] },
    );

    expect(trace.segments).toHaveLength(1);
    expect(trace.segments[0]?.phases[0]?.steps).toHaveLength(2);
  });
});

describe('buildRunTrace command steps', () => {
  test('marks a test command as test and every other bash call as its own command', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('b1', 'Bash', { command: 'bun test packages/cluster-ui' }),
          toolUse('b2', 'Bash', { command: 'ls -la src' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    const steps = trace.segments[0]?.phases[0]?.steps ?? [];
    expect(steps.map((step) => step.kind)).toEqual(['test', 'command']);
    expect(steps.map((step) => step.title)).toEqual(['执行 bash: bun test packages/cluster-ui', '执行 bash: ls -la src']);
  });
});

describe('buildRunTrace results and files', () => {
  test('attaches a failed tool_result to the call step and marks it failed', () => {
    const steps = stepsOf(
      jsonl(
        toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'ENOENT' }] },
        },
      ),
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'explore', failed: true });
    expect(steps[0]?.entryIds).toEqual(['t0', 't1']);
  });

  test('orders edited files before read-only ones, edits descending', () => {
    const trace = buildRunTrace(
      parse(
        jsonl(
          toolUse('u1', 'Read', { file_path: 'src/a.ts' }),
          toolUse('e1', 'Edit', { file_path: 'src/b.ts' }),
          toolUse('e2', 'Edit', { file_path: 'src/c.ts' }),
          toolUse('e3', 'Edit', { file_path: 'src/b.ts' }),
          assistant({ type: 'text', text: '改完了' }),
          toolUse('u2', 'Read', { file_path: 'src/a.ts' }),
        ),
      ),
      { truncated: false, resumes: [] },
    );

    expect(trace.files.map((file) => file.path)).toEqual(['src/b.ts', 'src/c.ts', 'src/a.ts']);
    expect(trace.files.map((file) => [file.reads, file.edits])).toEqual([
      [0, 2],
      [0, 1],
      [2, 0],
    ]);
    expect(trace.files[0]?.stepIds).toHaveLength(1);
  });
});

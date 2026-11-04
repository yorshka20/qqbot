import { describe, expect, test } from 'bun:test';
import { parseTranscript, toolTitle } from './transcript';

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content } });

describe('parseTranscript', () => {
  test('returns null for plain text output', () => {
    expect(parseTranscript('$ bun test\n12 pass\n0 fail')).toBeNull();
  });

  test('returns null for empty output', () => {
    expect(parseTranscript('')).toBeNull();
    expect(parseTranscript('\n  \n')).toBeNull();
  });

  test('keeps an assistant text block whole in body', () => {
    const text = '先看一下入口。\n再改 Shell。';
    const entries = parseTranscript(jsonl(assistant({ type: 'text', text })));
    expect(entries).toEqual([{ id: 't0', kind: 'text', title: '先看一下入口。', body: text }]);
  });

  test('titles a Read tool_use with the repo-relative path', () => {
    const entries = parseTranscript(
      jsonl(assistant({ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/work/repo/src/app/Shell.tsx' } })),
    );
    expect(entries?.[0]).toMatchObject({ kind: 'tool', title: '读取 src/app/Shell.tsx' });
    expect(entries?.[0]?.body).toContain('"file_path"');
  });

  test('marks an errored tool_result as failed', () => {
    const entries = parseTranscript(
      jsonl({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'ENOENT: no such file\nat x' }] },
      }),
    );
    expect(entries?.[0]).toMatchObject({
      kind: 'tool',
      title: '结果 · ENOENT: no such file',
      body: 'ENOENT: no such file\nat x',
      failed: true,
    });
  });

  test('joins text blocks of an array tool_result', () => {
    const entries = parseTranscript(
      jsonl({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
      }),
    );
    expect(entries?.[0]).toMatchObject({ body: 'a\nb', failed: false });
  });

  test('skips heartbeat events, which say nothing about the work', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
      JSON.stringify({ type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 30 }),
      JSON.stringify({ type: 'rate_limit_event' }),
    ];
    expect(parseTranscript(lines.join('\n'))?.map((entry) => entry.kind)).toEqual(['text']);
  });

  test('skips system init events', () => {
    const entries = parseTranscript(
      jsonl({ type: 'system', subtype: 'init', session_id: 's' }, assistant({ type: 'text', text: '开始' })),
    );
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.kind).toBe('text');
  });

  test('marks an errored result as failed with its own title', () => {
    const entries = parseTranscript(jsonl({ type: 'result', is_error: true, result: 'API Error: 400 bad request' }));
    expect(entries?.[0]).toMatchObject({ kind: 'result', title: '运行出错', body: 'API Error: 400 bad request', failed: true });
  });

  test('maps the final result and reasoning blocks', () => {
    const entries = parseTranscript(
      jsonl(assistant({ type: 'thinking', thinking: '想想怎么拆\n第二行' }), { type: 'result', subtype: 'success', result: '完成了' }),
    );
    expect(entries?.[0]).toMatchObject({ kind: 'reasoning', title: '思考 · 想想怎么拆' });
    expect(entries?.[1]).toMatchObject({ kind: 'result', title: '最终答复', body: '完成了', failed: false });
  });

  test('maps a codex agent_message item to text', () => {
    const entries = parseTranscript(
      jsonl(
        { type: 'thread.started', thread_id: 'th1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: '已经改好了' } },
        { type: 'turn.completed', usage: {} },
      ),
    );
    expect(entries).toEqual([{ id: 't2', kind: 'text', title: '已经改好了', body: '已经改好了' }]);
  });

  test('collapses a codex item started then completed into one row', () => {
    const entries = parseTranscript(
      jsonl(
        { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bun test', status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'bun test', aggregated_output: 'ok', exit_code: 1 } },
      ),
    );
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({ id: 't0', kind: 'tool', title: '执行 bash: bun test', body: 'ok', failed: true });
  });

  test('keeps a codex item it cannot read as raw instead of dropping it', () => {
    const unreadable = (id: string) => JSON.stringify({ type: 'item.completed', item: { id, type: 'agent_message' } });
    const entries = parseTranscript(`${unreadable('i2')}\n${unreadable('i3')}`);
    expect(entries?.map((entry) => entry.kind)).toEqual(['raw', 'raw']);
  });

  test('keeps a stderr line mixed into the stream as raw', () => {
    const entries = parseTranscript(
      [JSON.stringify(assistant({ type: 'text', text: '好' })), 'warning: something on stderr', JSON.stringify({ type: 'result', result: 'done' })].join('\n'),
    );
    expect(entries?.map((entry) => entry.kind)).toEqual(['text', 'raw', 'result']);
    expect(entries?.[1]).toMatchObject({ id: 't1', title: 'warning: something on stderr', body: 'warning: something on stderr' });
  });

  test('leaves at undefined when the event carries no time', () => {
    const entries = parseTranscript(jsonl(assistant({ type: 'text', text: '好' })));
    expect(entries?.[0]?.at).toBeUndefined();
  });

  test('reads the time an event carries, in ms or seconds or ISO', () => {
    const entries = parseTranscript(
      jsonl(
        { ...assistant({ type: 'text', text: 'a' }), timestamp: '2026-11-04T08:00:00.000Z' },
        { ...assistant({ type: 'text', text: 'b' }), created_at: 1762243200 },
        { ...assistant({ type: 'text', text: 'c' }), time: 1762243200123 },
      ),
    );
    expect(entries?.map((entry) => entry.at)).toEqual([Date.parse('2026-11-04T08:00:00.000Z'), 1762243200000, 1762243200123]);
  });
});

describe('toolTitle', () => {
  test('shapes a Bash command and clips long arguments', () => {
    expect(toolTitle('Bash', { command: 'bun test packages/cluster-ui' })).toBe('执行 bash: bun test packages/cluster-ui');
    const long = toolTitle('Bash', { command: `bun test ${'x'.repeat(200)}` });
    expect(long.startsWith('执行 bash: bun test ')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBe('执行 bash: '.length + 80 + 1);
  });

  test('names the common tools with their key argument', () => {
    expect(toolTitle('Grep', { pattern: 'useOutput' })).toBe('搜索 useOutput');
    expect(toolTitle('Edit', { file_path: 'src/runs/LogPane.tsx' })).toBe('编辑 src/runs/LogPane.tsx');
    expect(toolTitle('TodoWrite', { todos: [] })).toBe('更新任务清单');
  });

  test('shortens an absolute path to its repo-internal part', () => {
    expect(toolTitle('Read', { file_path: '/work/repo/packages/cluster-ui/src/app/Shell.tsx' })).toBe(
      '读取 packages/cluster-ui/src/app/Shell.tsx',
    );
  });

  test('formats mcp and unknown tools', () => {
    expect(toolTitle('mcp__hub__hub_report', {})).toBe('调用 hub · hub_report');
    expect(toolTitle('Frobnicate', {})).toBe('调用 Frobnicate');
  });
});

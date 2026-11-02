import { describe, expect, test } from 'bun:test';
import {
  renderTaskOutcome,
  renderTaskRecord,
  renderTaskState,
  taskDirectoryName,
  taskRecordLine,
} from '../taskWorkspace';
import type { AgentTask } from '../types';

const CREATED_AT = new Date(2026, 9, 10, 16, 52, 3);

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    executor: 'dsh',
    model: 'deepseek-flash',
    prompt: '调研三个向量数据库',
    workingDirectory: '/Users/someone/workspace/2026-10-10-调研三个向量数据库',
    createdAt: CREATED_AT,
    status: 'pending',
    requestedBy: { type: 'group', id: '10000001', userId: '10000002' },
    taskType: 'workspace',
    ...overrides,
  };
}

describe('taskDirectoryName', () => {
  test('prefixes the day and keeps a readable slug of the request', () => {
    expect(taskDirectoryName('调研三个向量数据库', 'abc', CREATED_AT)).toBe('2026-10-10-调研三个向量数据库');
  });

  test('uses only the first line of a multi-line request', () => {
    expect(taskDirectoryName('做一个单页网页\n\n要求：暗色主题', 'abc', CREATED_AT)).toBe('2026-10-10-做一个单页网页');
  });

  test('folds path-hostile characters and whitespace runs into single dashes', () => {
    expect(taskDirectoryName('Fix   the /auth:  bug?', 'abc', CREATED_AT)).toBe('2026-10-10-fix-the-auth-bug');
  });

  test('never returns a name that escapes the workspace root', () => {
    const name = taskDirectoryName('../../etc/passwd', 'abc', CREATED_AT);
    expect(name).toBe('2026-10-10-etc-passwd');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  test('caps a very long request', () => {
    const name = taskDirectoryName('x'.repeat(300), 'abc', CREATED_AT);
    expect(name).toBe(`2026-10-10-${'x'.repeat(40)}`);
  });

  test('falls back to the task id when the request has no usable characters', () => {
    expect(taskDirectoryName('   ', 'abcdef1234567890', CREATED_AT)).toBe('2026-10-10-abcdef12');
  });
});

describe('renderTaskRecord', () => {
  test('states who asked for what, and opens an empty record', () => {
    const record = renderTaskRecord(makeTask());

    expect(record).toContain('# 任务 11111111');
    expect(record).toContain('- 任务 ID: 11111111-2222-3333-4444-555555555555');
    expect(record).toContain('- 执行者: dsh');
    expect(record).toContain('- 模型: deepseek-flash');
    expect(record).toContain('- 请求者: 群 10000001（用户 10000002）');
    expect(record).toContain('- 工作目录: /Users/someone/workspace/2026-10-10-调研三个向量数据库');
    expect(record).toContain('- 创建时间: 2026-10-10 16:52:03');
    expect(record).toContain('## 任务要求\n\n调研三个向量数据库');
    // The record section is opened empty; every line after it is appended as the task runs.
    expect(record.endsWith('## 记录\n')).toBe(true);
  });

  test('names the effort only when the task set one', () => {
    expect(renderTaskRecord(makeTask({ effort: 'high' }))).toContain('- 模型: deepseek-flash（强度 high）');
    expect(renderTaskRecord(makeTask())).not.toContain('强度');
  });

  test('addresses a private requester by user id', () => {
    const record = renderTaskRecord(makeTask({ requestedBy: { type: 'user', id: '10000001' } }));
    expect(record).toContain('- 请求者: 用户 10000001');
  });
});

describe('renderTaskOutcome', () => {
  test('records the result of a completed task', () => {
    const outcome = renderTaskOutcome(makeTask({ status: 'completed', result: '结论：甲更好' }), CREATED_AT);
    expect(outcome).toContain('执行完成');
    expect(outcome).toContain('## 结果\n\n结论：甲更好');
  });

  test('records why a task failed, and says so when the CLI gave no reason', () => {
    expect(renderTaskOutcome(makeTask({ status: 'failed', error: 'idle timeout' }), CREATED_AT)).toContain(
      '## 错误\n\nidle timeout',
    );
    expect(renderTaskOutcome(makeTask({ status: 'failed' }), CREATED_AT)).toContain('## 错误\n\n（未知错误）');
  });

  test('says so when a completed task produced nothing', () => {
    expect(renderTaskOutcome(makeTask({ status: 'completed', result: '' }), CREATED_AT)).toContain(
      '## 结果\n\n（无输出）',
    );
  });
});

describe('taskRecordLine', () => {
  test('is one timestamped bullet', () => {
    expect(taskRecordLine(CREATED_AT, '开始执行')).toBe('- 2026-10-10 16:52:03 开始执行');
  });
});

describe('renderTaskState', () => {
  test('carries what the task views need, without the transcript', () => {
    const state = renderTaskState(
      makeTask({
        status: 'completed',
        startedAt: new Date(2026, 9, 10, 16, 53, 0),
        finishedAt: new Date(2026, 9, 10, 17, 1, 30),
        result: '结论：甲更好',
        projectContext: { alias: 'qqbot', type: 'bun', hasClaudeMd: true },
      }),
    );

    expect(state).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      executor: 'dsh',
      model: 'deepseek-flash',
      taskType: 'workspace',
      projectAlias: 'qqbot',
      workingDirectory: '/Users/someone/workspace/2026-10-10-调研三个向量数据库',
      prompt: '调研三个向量数据库',
      requestedBy: { type: 'group', id: '10000001', userId: '10000002' },
      status: 'completed',
      createdAt: CREATED_AT.toISOString(),
      startedAt: new Date(2026, 9, 10, 16, 53, 0).toISOString(),
      finishedAt: new Date(2026, 9, 10, 17, 1, 30).toISOString(),
      result: '结论：甲更好',
    });
  });

  test('leaves out the fields a task never set', () => {
    const state = renderTaskState(makeTask({ taskType: undefined, effort: undefined }));
    expect('effort' in state).toBe(false);
    expect('projectAlias' in state).toBe(false);
    expect('startedAt' in state).toBe(false);
    expect('result' in state).toBe(false);
    expect(state.taskType).toBe('dev');
  });
});

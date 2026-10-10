import { describe, expect, test } from 'bun:test';
import {
  renderTaskOutcome,
  renderTaskRecord,
  taskRecordLine,
  workspaceDirectoryName,
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

describe('workspaceDirectoryName', () => {
  test('prefixes the day and keeps a readable slug of the request', () => {
    expect(workspaceDirectoryName('调研三个向量数据库', 'abc', CREATED_AT)).toBe('2026-10-10-调研三个向量数据库');
  });

  test('uses only the first line of a multi-line request', () => {
    expect(workspaceDirectoryName('做一个单页网页\n\n要求：暗色主题', 'abc', CREATED_AT)).toBe('2026-10-10-做一个单页网页');
  });

  test('folds path-hostile characters and whitespace runs into single dashes', () => {
    expect(workspaceDirectoryName('Fix   the /auth:  bug?', 'abc', CREATED_AT)).toBe('2026-10-10-fix-the-auth-bug');
  });

  test('never returns a name that escapes the workspace root', () => {
    const name = workspaceDirectoryName('../../etc/passwd', 'abc', CREATED_AT);
    expect(name).toBe('2026-10-10-etc-passwd');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  test('caps a very long request', () => {
    const name = workspaceDirectoryName('x'.repeat(300), 'abc', CREATED_AT);
    expect(name).toBe(`2026-10-10-${'x'.repeat(40)}`);
  });

  test('falls back to the task id when the request has no usable characters', () => {
    expect(workspaceDirectoryName('   ', 'abcdef1234567890', CREATED_AT)).toBe('2026-10-10-abcdef12');
  });
});

describe('renderTaskRecord', () => {
  test('states who asked for what, and opens an empty record', () => {
    const record = renderTaskRecord(makeTask());

    expect(record).toContain('# 工作区任务 11111111');
    expect(record).toContain('- 任务 ID: 11111111-2222-3333-4444-555555555555');
    expect(record).toContain('- 执行者: dsh');
    expect(record).toContain('- 模型: deepseek-flash');
    expect(record).toContain('- 请求者: 群 10000001（用户 10000002）');
    expect(record).toContain('- 创建时间: 2026-10-10 16:52:03');
    expect(record).toContain('## 任务要求\n\n调研三个向量数据库');
    expect(record).toContain('任务创建，等待执行');
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

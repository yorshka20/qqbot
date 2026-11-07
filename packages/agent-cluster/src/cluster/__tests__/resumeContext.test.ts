import { describe, expect, test } from 'bun:test';
import { renderChildren, renderWorkspaceChanges } from '../resumeContext';
import type { WorkspaceCatchUp } from '../types';

const advanced: WorkspaceCatchUp = {
  previousHead: 'a'.repeat(40),
  head: 'b'.repeat(40),
  advanced: true,
  commits: [{ sha: 'c'.repeat(40), subject: 'add the sibling feature' }],
  changedFiles: ['A\tsrc/sibling.ts'],
};

describe('renderWorkspaceChanges', () => {
  test('lists the fast-forward, commits, files and how the task ended last time', () => {
    const text = renderWorkspaceChanges(advanced, 'cluster/job', {
      status: 'blocked',
      error: 'merge conflict',
      diffSummary: 'did the first half',
    });
    expect(text).toContain('## 你上次结束以来，工作区的变化');
    expect(text).toContain('cluster/job@bbbbbbb');
    expect(text).toContain('- ccccccc add the sibling feature');
    expect(text).toContain('- A\tsrc/sibling.ts');
    expect(text).toContain('blocked');
    expect(text).toContain('merge conflict');
    expect(text).toContain('did the first half');
  });

  test('a branch that was not moved tells the task to merge the integration branch itself', () => {
    const text = renderWorkspaceChanges(
      { ...advanced, advanced: false, reason: 'task has commits integration does not' },
      'cluster/job',
      undefined,
    );
    expect(text).toContain('git merge $CLUSTER_INTEGRATION_BRANCH');
    expect(text).toContain('task has commits integration does not');
  });

  test('an unpooled task has nothing to say', () => {
    expect(renderWorkspaceChanges(undefined, undefined, { status: 'completed' })).toBe('');
  });
});

describe('renderChildren', () => {
  test('one line per child with the continue hint, long text clipped', () => {
    const text = renderChildren([
      {
        id: 'task-1',
        workerTemplate: 'fake-executor',
        status: 'completed',
        merged: true,
        resumable: true,
        description: `${'x'.repeat(200)}\nsecond line`,
        diffSummary: 'y'.repeat(500),
      },
      { id: 'task-2', status: 'pending', merged: false, resumable: false, description: 'queued' },
    ]);
    expect(text).toContain('## 你已有的子任务');
    expect(text).toContain('task-1 | fake-executor | completed | 已合入 | 可续用 | ');
    expect(text).toContain('task-2 | - | pending | 未合入 | 不可续用 | queued');
    expect(text).not.toContain('x'.repeat(100));
    expect(text).not.toContain('y'.repeat(250));
    expect(text).toContain('hub_continue');
  });

  test('no children renders nothing', () => {
    expect(renderChildren([])).toBe('');
  });
});

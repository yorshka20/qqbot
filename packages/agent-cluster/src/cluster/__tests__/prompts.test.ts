import { describe, expect, test } from 'bun:test';
import { loadClusterPrompt, renderPrompt, workspacePromptName, workspacePromptVars } from '../prompts';
import type { WorkerWorkspace } from '../types';

const pooledPlanner: WorkerWorkspace = {
  cwd: '/work/proj/planner-1',
  env: {},
  mode: 'pooled',
  kind: 'planner',
  branch: 'cluster/aaaaaaaa-33333333',
  integrationBranch: 'cluster/aaaaaaaa',
};

describe('cluster prompt files', () => {
  test('every workspace mode and role has a template, and each renders with no token left', async () => {
    for (const mode of ['pooled', 'shared'] as const) {
      for (const kind of ['executor', 'planner'] as const) {
        const workspace: WorkerWorkspace = { ...pooledPlanner, mode, kind };
        const template = await loadClusterPrompt(workspacePromptName(workspace), '/nonexistent');
        expect(template.length).toBeGreaterThan(0);
        const rendered = renderPrompt(template, workspacePromptVars(workspace));
        expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
        expect(rendered).toContain(workspace.cwd);
      }
    }
  });

  test('the pooled planner note names the integration branch; the shared one has none', async () => {
    const pooled = renderPrompt(await loadClusterPrompt(workspacePromptName(pooledPlanner), '/x'), workspacePromptVars(pooledPlanner));
    expect(pooled).toContain('cluster/aaaaaaaa');
    const shared: WorkerWorkspace = { cwd: '/repo', env: {}, mode: 'shared', kind: 'planner' };
    expect(renderPrompt(await loadClusterPrompt(workspacePromptName(shared), '/x'), workspacePromptVars(shared))).not.toContain('{{');
  });

  test('an unknown token is left in place so it is visible', () => {
    expect(renderPrompt('a {{MISSING}} b', {})).toBe('a {{MISSING}} b');
  });
});

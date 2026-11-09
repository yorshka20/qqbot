/**
 * Prompt text lives in `prompts/cluster/*.md`; code only loads a file and fills its
 * `{{PLACEHOLDER}}` tokens. A per-project copy at `<projectPath>/prompts/cluster/<name>` wins
 * over the repo default.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getRepoRoot, logger } from '@qqbot/shared';
import type { WorkerWorkspace } from './types';

const cache = new Map<string, string>();

/** The repo's own copy of a prompt, read once: for text the hub composes inside a synchronous tool call. */
export function readClusterPrompt(name: string): string {
  const path = resolvePath(getRepoRoot(), `prompts/cluster/${name}`);
  const cached = cache.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const content = readFileSync(path, 'utf-8');
  cache.set(path, content);
  return content;
}

export async function loadClusterPrompt(name: string, projectPath: string): Promise<string> {
  const relativePath = `prompts/cluster/${name}`;
  const candidates = [resolvePath(projectPath, relativePath), resolvePath(getRepoRoot(), relativePath)];
  for (const path of candidates) {
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const content = await readFile(path, 'utf-8');
      logger.info(`[ClusterPrompts] Loaded ${name} from ${path} (${content.length} chars)`);
      cache.set(path, content);
      return content;
    } catch {
      // try next candidate
    }
  }
  logger.warn(`[ClusterPrompts] ${name} not found at any candidate path: ${candidates.join(', ')}`);
  return '';
}

export function renderPrompt(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (token, key: string) => vars[key] ?? token);
}

/** The planner's working mode; executors have none. */
export function planningPromptName(workspace: WorkerWorkspace): string | null {
  return workspace.kind === 'planner' ? `planning-${workspace.planning}.md` : null;
}

/** Who writes the job's knowledge-base entry: a child's planner does; a standalone executor does itself. */
export function docsDutyPromptName(role: 'planner' | 'coder', hasParent: boolean): string | null {
  if (role === 'planner') {
    return null;
  }
  return hasParent ? 'docs-child-executor.md' : 'docs-standalone-executor.md';
}

export function workspacePromptName(workspace: WorkerWorkspace): string {
  return `workspace-${workspace.mode}-${workspace.kind}.md`;
}

export function workspacePromptVars(workspace: WorkerWorkspace): Record<string, string | undefined> {
  return {
    WORKSPACE_PATH: workspace.cwd,
    TASK_BRANCH: workspace.branch,
    INTEGRATION_BRANCH: workspace.integrationBranch,
    BASE_BRANCH: workspace.baseBranch,
  };
}

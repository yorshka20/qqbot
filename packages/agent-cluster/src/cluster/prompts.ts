/**
 * Prompt text lives in `prompts/cluster/*.md`; code only loads a file and fills its
 * `{{PLACEHOLDER}}` tokens. A per-project copy at `<projectPath>/prompts/cluster/<name>` wins
 * over the repo default.
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { getRepoRoot, logger } from '@qqbot/shared';
import type { WorkerWorkspace } from './types';

const cache = new Map<string, string>();

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

export function workspacePromptName(workspace: WorkerWorkspace): string {
  return `workspace-${workspace.mode}-${workspace.kind}.md`;
}

export function workspacePromptVars(workspace: WorkerWorkspace): Record<string, string | undefined> {
  return {
    WORKSPACE_PATH: workspace.cwd,
    TASK_BRANCH: workspace.branch,
    INTEGRATION_BRANCH: workspace.integrationBranch,
  };
}

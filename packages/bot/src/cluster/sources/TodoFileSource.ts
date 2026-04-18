/**
 * TodoFileSource — scans project todo.md for tasks.
 *
 * Extracted from TodoWorkerHandler logic.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import type { TaskCandidate } from '../types';
import type { ProjectInfo, TaskSource } from './TaskSource';

export class TodoFileSource implements TaskSource {
  name = 'todo-file';

  constructor(private relativePath: string = 'todo.md') {}

  async poll(project: ProjectInfo): Promise<TaskCandidate[]> {
    const filePath = join(project.path, this.relativePath);

    try {
      const content = await readFile(filePath, 'utf-8');
      return this.parseTodoFile(content, project);
    } catch (err) {
      // File doesn't exist — no tasks
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.warn(`[TodoFileSource] Failed to read ${filePath}:`, err);
      return [];
    }
  }

  private parseTodoFile(content: string, project: ProjectInfo): TaskCandidate[] {
    const candidates: TaskCandidate[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Match unchecked checkboxes: - [ ] description
      const match = trimmed.match(/^-\s*\[\s*\]\s+(.+)$/);
      if (match) {
        candidates.push({
          description: match[1].trim(),
          source: 'todo-file',
          project: project.alias,
          priority: 5, // default priority
        });
      }
    }

    return candidates;
  }
}

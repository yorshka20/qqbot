/**
 * Wire ticket result writeback — when a cluster job completes, write
 * task results back into the ticket directory so the full execution
 * history is preserved alongside the original ticket.
 *
 * Output structure (per ticket):
 *   tickets/<ticketId>/results/
 *     summary.md             — job completion summary
 *     task-<taskId>.md       — per-task description + output
 */

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import type { ClusterManager } from './ClusterManager';
import type { JobRecord, TaskRecord } from './types';

const TICKETS_DIR = join(process.cwd(), 'tickets');

export function wireClusterTicketWriteback(clusterManager: ClusterManager): void {
  clusterManager.setJobCompletedCallback((job, tasks) => {
    if (!job.ticketId) return;
    void writeResults(job, tasks).catch((err) => {
      logger.error(`[ClusterTicketWriteback] Failed to write results for ticket ${job.ticketId}:`, err);
    });
  });
  logger.info('[ClusterTicketWriteback] Wired to cluster job completion');
}

async function writeResults(job: JobRecord, tasks: TaskRecord[]): Promise<void> {
  const ticketDir = join(TICKETS_DIR, job.ticketId!);
  if (!existsSync(ticketDir)) {
    logger.warn(`[ClusterTicketWriteback] Ticket directory not found: ${ticketDir}`);
    return;
  }

  const resultsDir = join(ticketDir, 'results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  // Write per-task result files
  for (const task of tasks) {
    const filename = `task-${task.id.slice(0, 8)}.md`;
    const lines: string[] = [
      '---',
      `taskId: ${task.id}`,
      `status: ${task.status}`,
      `worker: ${task.workerId ?? 'N/A'}`,
      `template: ${task.workerTemplate ?? 'N/A'}`,
      `source: ${task.source}`,
      task.parentTaskId ? `parentTaskId: ${task.parentTaskId}` : null,
      `created: ${task.createdAt}`,
      task.startedAt ? `started: ${task.startedAt}` : null,
      task.completedAt ? `completed: ${task.completedAt}` : null,
      '---',
      '',
      '## Description (input prompt)',
      '',
      task.description,
      '',
    ].filter((l): l is string => l !== null);

    if (task.output) {
      lines.push('## Output', '', task.output, '');
    }
    if (task.error) {
      lines.push('## Error', '', task.error, '');
    }

    await writeFile(join(resultsDir, filename), lines.join('\n'), 'utf-8');
  }

  // Write summary
  const plannerTask = tasks.find((t) => t.source !== 'planner' && !t.parentTaskId);
  const childTasks = tasks.filter((t) => t.parentTaskId);

  const summaryLines: string[] = [
    `# Job Summary`,
    '',
    `- **Job ID**: ${job.id}`,
    `- **Status**: ${job.status}`,
    `- **Project**: ${job.project}`,
    `- **Created**: ${job.createdAt}`,
    `- **Completed**: ${job.completedAt ?? 'N/A'}`,
    `- **Tasks**: ${job.tasksCompleted} completed, ${job.tasksFailed} failed / ${job.taskCount} total`,
    '',
  ];

  if (plannerTask) {
    summaryLines.push(
      '## Planner',
      '',
      `- **Task ID**: ${plannerTask.id}`,
      `- **Template**: ${plannerTask.workerTemplate ?? 'N/A'}`,
      `- **Status**: ${plannerTask.status}`,
      '',
    );
    if (plannerTask.output) {
      summaryLines.push('### Planner Output', '', plannerTask.output, '');
    }
  }

  if (childTasks.length > 0) {
    summaryLines.push('## Executor Tasks', '');
    for (const child of childTasks) {
      const statusIcon = child.status === 'completed' ? '[ok]' : '[FAIL]';
      summaryLines.push(
        `### ${statusIcon} task-${child.id.slice(0, 8)} (${child.workerTemplate ?? 'unknown'})`,
        '',
        `**Description**: ${child.description.slice(0, 200)}${child.description.length > 200 ? '...' : ''}`,
        '',
      );
      if (child.output) {
        summaryLines.push(`**Output**: ${child.output.slice(0, 500)}${child.output.length > 500 ? '...' : ''}`, '');
      }
      if (child.error) {
        summaryLines.push(`**Error**: ${child.error}`, '');
      }
    }
  }

  await writeFile(join(resultsDir, 'summary.md'), summaryLines.join('\n'), 'utf-8');

  logger.info(`[ClusterTicketWriteback] Wrote ${tasks.length} task result(s) + summary for ticket ${job.ticketId}`);
}

/**
 * Wire ticket result writeback — when a cluster job completes, write
 * compact task metadata into the ticket directory (no worker stdout).
 *
 * Output structure (per ticket, under the configured tickets directory):
 *   <ticketsDir>/<ticketId>/results/
 *     summary.md             — job completion summary (human-readable)
 *     job.json               — structured job snapshot (clusterId, status, workers, task ids)
 *     task-<taskId>.md       — per-task description + report summary + errors
 *
 * Cross-LAN model: cluster-tickets is a git-synced repo shared across LAN
 * instances. Filenames are stable per-ticket (not per-jobId) because only
 * the latest dispatch result is kept — re-dispatching a ticket overwrites
 * `summary.md` / `job.json` and prunes `task-*.md` files whose taskId is
 * not in the current dispatch. `clusterId` inside `job.json` identifies
 * which machine produced the result.
 *
 * Live worker output is shown only in the local WebUI during execution
 * (polling active tasks); it is not written here or to SQLite.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findTicketDir } from '@/services/staticServer/backends/ticketStorage';
import { logger } from '@/utils/logger';
import type { ClusterManager } from './ClusterManager';
import type { JobRecord, TaskRecord, WorkerRegistration } from './types';

/**
 * Tickets directory is taken from `ClusterManager.getTicketsDir()`, which
 * in turn was resolved from `Config.getTicketsDir()` during bootstrap.
 * Captured in closure so the job-completed callback doesn't re-read config.
 */
export function wireClusterTicketWriteback(clusterManager: ClusterManager): void {
  const ticketsDir = clusterManager.getTicketsDir();
  const clusterId = clusterManager.getConfig().clusterId;
  clusterManager.setJobCompletedCallback((job, tasks) => {
    if (!job.ticketId) return;
    const workers = clusterManager.getHub().workerRegistry.getWorkersByJobId(job.id);
    void writeResults(ticketsDir, clusterId, job, tasks, workers).catch((err) => {
      logger.error(`[ClusterTicketWriteback] Failed to write results for ticket ${job.ticketId}:`, err);
    });
  });
  logger.info(
    `[ClusterTicketWriteback] Wired to cluster job completion (tickets dir: ${ticketsDir}, clusterId: ${clusterId})`,
  );
}

async function writeResults(
  ticketsDir: string,
  clusterId: string,
  job: JobRecord,
  tasks: TaskRecord[],
  workers: WorkerRegistration[],
): Promise<void> {
  const ticketId = job.ticketId;
  if (!ticketId) return;

  const ticketDir = findTicketDir(ticketsDir, ticketId);
  if (!ticketDir) {
    logger.warn(`[ClusterTicketWriteback] Ticket dir not found for ${ticketId} under ${ticketsDir}`);
    return;
  }

  const resultsDir = join(ticketDir, 'results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  // Prune stale task files from prior dispatches: keep only task-*.md whose
  // short id matches one of the current dispatch's tasks. Unknown files are
  // left alone (user notes, manual copies).
  const currentShortIds = new Set(tasks.map((t) => t.id.slice(0, 8)));
  try {
    const entries = await readdir(resultsDir);
    for (const entry of entries) {
      const match = entry.match(/^task-([0-9a-f]{8})\.md$/);
      if (!match) continue;
      if (currentShortIds.has(match[1])) continue;
      await unlink(join(resultsDir, entry)).catch(() => {});
    }
  } catch (err) {
    logger.warn(`[ClusterTicketWriteback] Failed to prune stale task files in ${resultsDir}:`, err);
  }

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

    if (task.diffSummary) {
      lines.push('## Report summary (hub_report)', '', task.diffSummary, '');
    }
    if (task.filesModified) {
      lines.push('## Files modified', '', task.filesModified, '');
    }
    if (task.error) {
      lines.push('## Error', '', task.error, '');
    }

    lines.push(
      '',
      '_Worker CLI output is not written to disk; it was visible in the WebUI while the task was running._',
      '',
    );

    await writeFile(join(resultsDir, filename), lines.join('\n'), 'utf-8');
  }

  const plannerTask = tasks.find((t) => t.source !== 'planner' && !t.parentTaskId);
  const childTasks = tasks.filter((t) => t.parentTaskId);

  const summaryLines: string[] = [
    `# Job Summary`,
    '',
    `- **Job ID**: ${job.id}`,
    `- **Cluster**: ${clusterId}`,
    `- **Status**: ${job.status}`,
    `- **Project**: ${job.project}`,
    `- **Created**: ${job.createdAt}`,
    `- **Completed**: ${job.completedAt ?? 'N/A'}`,
    `- **Tasks**: ${job.tasksCompleted} completed, ${job.tasksFailed} failed / ${job.taskCount} total`,
    '',
    '_Live worker output is not persisted; this file lists hub_report summaries and errors only._',
    '',
  ];

  if (plannerTask) {
    const plannerResultFile = `task-${plannerTask.id.slice(0, 8)}.md`;
    summaryLines.push(
      '## Planner',
      '',
      `- **Task ID**: ${plannerTask.id}`,
      `- **Template**: ${plannerTask.workerTemplate ?? 'N/A'}`,
      `- **Status**: ${plannerTask.status}`,
      '',
    );
    if (plannerTask.diffSummary) {
      summaryLines.push('### Report summary', '', plannerTask.diffSummary, '');
    }
    summaryLines.push(`_Per-task file: \`results/${plannerResultFile}\`._`, '');
  }

  if (childTasks.length > 0) {
    summaryLines.push('## Executor Tasks', '');
    for (const child of childTasks) {
      const statusIcon = child.status === 'completed' ? '[ok]' : '[FAIL]';
      summaryLines.push(
        `### ${statusIcon} task-${child.id.slice(0, 8)} (${child.workerTemplate ?? 'unknown'})`,
        '',
        `**Description**:`,
        '',
        child.description,
        '',
      );
      if (child.diffSummary) {
        summaryLines.push('**Report summary**:', '', child.diffSummary, '');
      }
      if (child.error) {
        summaryLines.push('**Error**:', '', child.error, '');
      }
    }
  }

  await writeFile(join(resultsDir, 'summary.md'), summaryLines.join('\n'), 'utf-8');

  // Structured snapshot — consumed by remote WebUI viewers for nice rendering
  // without having to parse markdown. Only terminal-state fields are written
  // (no heartbeat/syncCursor noise).
  const jobSnapshot = {
    schemaVersion: 1,
    clusterId,
    job: {
      id: job.id,
      ticketId: job.ticketId,
      project: job.project,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      taskCount: job.taskCount,
      tasksCompleted: job.tasksCompleted,
      tasksFailed: job.tasksFailed,
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      shortId: t.id.slice(0, 8),
      parentTaskId: t.parentTaskId,
      workerId: t.workerId,
      workerTemplate: t.workerTemplate,
      source: t.source,
      status: t.status,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      diffSummary: t.diffSummary,
      filesModified: t.filesModified,
      error: t.error,
      resultFile: `task-${t.id.slice(0, 8)}.md`,
    })),
    workers: workers.map((w) => ({
      workerId: w.workerId,
      role: w.role,
      templateName: w.templateName,
      project: w.project,
      status: w.status,
      lastBoundTaskId: w.lastBoundTaskId,
      lastReportStatus: w.lastReportStatus,
      lastReportSummary: w.lastReportSummary,
      registeredAt: w.stats.registeredAt,
      exitedAt: w.exitedAt,
      stats: {
        tasksCompleted: w.stats.tasksCompleted,
        tasksFailed: w.stats.tasksFailed,
        totalReports: w.stats.totalReports,
      },
    })),
  };

  await writeFile(join(resultsDir, 'job.json'), `${JSON.stringify(jobSnapshot, null, 2)}\n`, 'utf-8');

  logger.info(
    `[ClusterTicketWriteback] Wrote ${tasks.length} task result(s) + summary + job.json for ticket ${ticketId}`,
  );
}

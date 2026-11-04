import type { ClusterTask, ClusterTemplatesResponse, Ticket } from '@qqbot/api-types';
import { acknowledgeClusterTask, createClusterJob, getClusterTask, updateTicket } from '../api';
import type { Run } from '../lib/runs';

export interface RunInput {
  project: string;
  description: string;
  template?: string;
  ticketId?: string;
}

/** The one way a run starts. A ticket's linkage is the client's to write: `POST /jobs` does not. */
export async function submitRun(input: RunInput, templates: ClusterTemplatesResponse | null): Promise<ClusterTask> {
  const role = templates?.templates.find((t) => t.name === input.template)?.role;
  const task = await createClusterJob({
    project: input.project,
    description: input.description,
    workerTemplate: input.template,
    requirePlannerRole: role === 'planner' ? true : undefined,
    ticketId: input.ticketId,
  });
  if (input.ticketId) {
    await updateTicket(input.ticketId, { status: 'dispatched', dispatchedJobId: task.jobId, project: input.project });
  }
  return task;
}

/** Phase 1 has no real retry: this submits a new run with the same words. List routes truncate them. */
export async function retryRun(run: Run, templates: ClusterTemplatesResponse | null): Promise<ClusterTask> {
  const { description } = await getClusterTask(run.task.id);
  const next = await submitRun(
    { project: run.task.project, description, template: run.task.workerTemplate, ticketId: run.ticketId },
    templates,
  );
  await acknowledgeClusterTask(run.task.id);
  return next;
}

/** A frontmatter block ahead of the body: the run takes its name from it, a planner its sizing hints. */
export function ticketDescription(ticket: Ticket, body: string): string {
  const { title, estimatedComplexity, maxChildren } = ticket.frontmatter;
  const lines = [
    `title: ${title}`,
    estimatedComplexity && `estimatedComplexity: ${estimatedComplexity}`,
    maxChildren && `maxChildren: ${maxChildren}`,
  ].filter(Boolean);
  return ['---', ...lines, '---', '', body].join('\n');
}

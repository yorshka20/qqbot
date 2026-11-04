import type { ClusterTask, ClusterTemplatesResponse, Ticket } from '@qqbot/api-types';
import { acknowledgeClusterTask, createClusterJob, createTicket, getClusterTask, updateTicket } from '../api';
import { needsPlannerTicket, plannerTicketDraft, type Run, resolveTemplate } from '../lib/runs';

export interface RunInput {
  project: string;
  description: string;
  template?: string;
  ticketId?: string;
}

export interface SubmittedRun {
  task: ClusterTask;
  /** Set when the run needed a ticket and the console made one for it. */
  createdTicketId?: string;
}

/** The one way a run starts. A ticket's linkage is the client's to write: `POST /jobs` does not. */
export async function submitRun(input: RunInput, templates: ClusterTemplatesResponse | null): Promise<SubmittedRun> {
  const template = resolveTemplate(input, templates);
  const role = templates?.templates.find((t) => t.name === template)?.role;
  let ticketId = input.ticketId;
  let createdTicketId: string | undefined;
  if (needsPlannerTicket(role, ticketId)) {
    const created = await createTicket(plannerTicketDraft(input.description, input.project, template ?? ''));
    ticketId = created.id;
    createdTicketId = created.id;
  }
  try {
    const task = await createClusterJob({
      project: input.project,
      description: input.description,
      workerTemplate: input.template,
      requirePlannerRole: role === 'planner' ? true : undefined,
      ticketId,
    });
    if (ticketId) {
      await updateTicket(ticketId, { status: 'dispatched', dispatchedJobId: task.jobId, project: input.project });
    }
    return { task, createdTicketId };
  } catch (err) {
    if (createdTicketId) {
      throw new Error(
        `已建 ticket ${createdTicketId}，但派发失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
}

/** Phase 1 has no real retry: this submits a new run with the same words. List routes truncate them. */
export async function retryRun(run: Run, templates: ClusterTemplatesResponse | null): Promise<SubmittedRun> {
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

// RepeatingTicketDispatchHandler — daily batch: every N minutes for M rounds, dispatch at most one
// `ready` cluster ticket per round (same semantics as WebUI dispatch). After the rounds, reports
// job outcomes for tickets that were dispatched in this run. Tickets and jobs live in the cluster
// daemon and are read and written over its HTTP API.

import type { ClusterJob, ClusterTemplatesResponse, TicketFrontmatter } from '@qqbot/api-types';
import { logger } from '@qqbot/shared';
import { injectable } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClusterClient } from '@/integrations/agent-cluster/ClusterClient';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

const TAG = '[RepeatingTicketDispatchHandler]';

interface HandlerParams {
  /** Number of check rounds (default: 5) */
  repeat?: number;
  /** Minutes between round 2..N and round 1 (default: 30) */
  intervalMinutes?: number;
}

interface RoundDispatch {
  round: number;
  ticketId?: string;
  jobId?: string;
  skipReason?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClusterDescription(body: string, fm: TicketFrontmatter): string {
  const parts: string[] = ['---'];
  if (fm.estimatedComplexity) {
    parts.push(`estimatedComplexity: ${fm.estimatedComplexity}`);
  }
  if (fm.maxChildren) {
    parts.push(`maxChildren: ${fm.maxChildren}`);
  }
  parts.push('---', '');
  parts.push(body);
  return parts.join('\n');
}

function isPlannerTemplate(templates: ClusterTemplatesResponse, templateName: string | undefined): boolean {
  const name = templateName?.trim();
  if (!name) {
    return false;
  }
  return templates.templates.some((t) => t.name === name && t.role === 'planner');
}

/** `ready` tickets that name a project, oldest id first. */
function readyWithProject(tickets: TicketFrontmatter[]): TicketFrontmatter[] {
  return tickets.filter((t) => t.status === 'ready' && t.project?.trim()).sort((a, b) => a.id.localeCompare(b.id));
}

function jobOutcomeLine(job: ClusterJob | null): string {
  if (!job) {
    return 'job unknown (not in scheduler)';
  }
  return `status=${job.status}, tasks ${job.tasksCompleted} ok / ${job.tasksFailed} fail / ${job.taskCount} total`;
}

@injectable()
export class RepeatingTicketDispatchHandler implements ActionHandler {
  readonly name = 'repeating_ticket_dispatch';

  async execute(ctx: ActionHandlerContext): Promise<string | undefined> {
    const params = this.parseParams(ctx.item.actionParams);
    const repeat = params.repeat ?? 5;
    const intervalMinutes = params.intervalMinutes ?? 30;

    // container-lookup: optional-service the cluster client exists only when clusterClient is configured
    const container = getContainer();
    if (!container.isRegistered(DITokens.CLUSTER_CLIENT)) {
      logger.error(`${TAG} cluster client not configured`);
      return '❌ repeating_ticket_dispatch: cluster 未配置（config.clusterClient）';
    }
    const cluster = container.resolve<ClusterClient>(DITokens.CLUSTER_CLIENT);

    const rounds: RoundDispatch[] = [];
    const start = Date.now();

    logger.info(`${TAG} Starting: repeat=${repeat}, interval=${intervalMinutes}min, daemon=${cluster.url}`);

    for (let round = 1; round <= repeat; round++) {
      if (round > 1) {
        await sleep(intervalMinutes * 60 * 1000);
      }

      let summary: TicketFrontmatter | undefined;
      try {
        summary = readyWithProject(await cluster.listTickets())[0];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rounds.push({ round, error: msg });
        logger.error(`${TAG} Round ${round}/${repeat}: listing tickets failed:`, err);
        continue;
      }
      if (!summary) {
        rounds.push({ round, skipReason: 'no ready ticket with project' });
        logger.info(`${TAG} Round ${round}/${repeat}: no ready tickets`);
        continue;
      }

      try {
        const ticket = await cluster.getTicket(summary.id);
        if (!ticket) {
          throw new Error('ticket disappeared between listing and reading');
        }
        const project = ticket.frontmatter.project?.trim();
        if (!project) {
          rounds.push({ round, ticketId: ticket.id, error: 'project missing on ready ticket' });
          continue;
        }
        const tpl = ticket.frontmatter.template?.trim();
        const requirePlanner = isPlannerTemplate(await cluster.getTemplates(), tpl);
        const description = buildClusterDescription(ticket.body, ticket.frontmatter);

        const task = await cluster.submitTask(project, description, {
          workerTemplate: tpl || undefined,
          requirePlannerRole: requirePlanner ? true : undefined,
          ticketId: ticket.id,
        });

        await cluster.updateTicket(ticket.id, { status: 'dispatched', dispatchedJobId: task.jobId, project });

        rounds.push({ round, ticketId: ticket.id, jobId: task.jobId });
        logger.info(`${TAG} Round ${round}/${repeat}: dispatched ${ticket.id} → job ${task.jobId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rounds.push({ round, ticketId: summary.id, error: msg });
        logger.error(`${TAG} Round ${round}/${repeat}: dispatch failed:`, err);
      }
    }

    const elapsedMin = Math.round((Date.now() - start) / 60_000);
    const lines: string[] = [
      `📋 repeating_ticket_dispatch 完成（${repeat} 轮，间隔 ${intervalMinutes} 分钟，耗时约 ${elapsedMin} 分钟）`,
      '',
      '**每轮结果**',
    ];

    const completedTickets: string[] = [];
    const failedJobs: string[] = [];
    const stillRunning: string[] = [];

    for (const r of rounds) {
      if (r.skipReason) {
        lines.push(`- 第 ${r.round} 轮: 跳过 — ${r.skipReason}`);
        continue;
      }
      if (r.error) {
        lines.push(`- 第 ${r.round} 轮: ❌ ${r.ticketId ?? '?'} — ${r.error}`);
        continue;
      }
      if (r.jobId && r.ticketId) {
        const job = await cluster.getJob(r.jobId).catch((err) => {
          logger.warn(`${TAG} could not read job ${r.jobId}:`, err);
          return null;
        });
        const out = jobOutcomeLine(job);
        lines.push(`- 第 ${r.round} 轮: ${r.ticketId} → job ${r.jobId} (${out})`);
        if (job?.status === 'completed') {
          completedTickets.push(r.ticketId);
        } else if (job?.status === 'failed' || job?.status === 'cancelled') {
          failedJobs.push(`${r.ticketId} (${job.status})`);
        } else {
          stillRunning.push(`${r.ticketId} (${job?.status ?? 'unknown'})`);
        }
      }
    }

    lines.push('', '**本批次已完成的 ticket（job 状态为 completed）**');
    if (completedTickets.length === 0) {
      lines.push('（无）');
    } else {
      for (const id of completedTickets) {
        lines.push(`- ${id}`);
      }
    }

    if (failedJobs.length > 0) {
      lines.push('', '**失败或取消的 job**');
      for (const x of failedJobs) {
        lines.push(`- ${x}`);
      }
    }

    if (stillRunning.length > 0) {
      lines.push('', '**仍在进行或未终态的 job**');
      for (const x of stillRunning) {
        lines.push(`- ${x}`);
      }
    }

    return lines.join('\n');
  }

  private parseParams(raw?: string): HandlerParams {
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw) as HandlerParams;
    } catch {
      return {};
    }
  }
}

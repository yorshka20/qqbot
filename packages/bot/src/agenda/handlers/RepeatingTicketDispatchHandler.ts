// RepeatingTicketDispatchHandler — daily batch: every N minutes for M rounds, dispatch at most one
// `ready` cluster ticket per round (same semantics as WebUI dispatch). After the rounds, reports
// job outcomes for tickets that were dispatched in this run.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClusterManager } from '@/cluster/ClusterManager';
import type { ClusterConfig } from '@/cluster/config';
import type { JobRecord } from '@/cluster/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { parseMarkdownTicket, serializeTicket } from '@/services/staticServer/backends/TicketBackend';
import { findTicketDir, iterateAllTickets } from '@/services/staticServer/backends/ticketStorage';
import { logger } from '@/utils/logger';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

const TAG = '[RepeatingTicketDispatchHandler]';

interface HandlerParams {
  /** Number of check rounds (default: 5) */
  repeat?: number;
  /** Minutes between round 2..N and round 1 (default: 30) */
  intervalMinutes?: number;
}

interface ParsedTicketFile {
  id: string;
  frontmatter: ReturnType<typeof parseMarkdownTicket>['frontmatter'];
  body: string;
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

function buildClusterDescription(body: string, fm: ParsedTicketFile['frontmatter']): string {
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

function isPlannerTemplate(config: ClusterConfig, templateName: string | undefined): boolean {
  const name = templateName?.trim();
  if (!name) {
    return false;
  }
  return config.workerTemplates[name]?.role === 'planner';
}

async function writeTicketFile(ticketsDir: string, ticket: ParsedTicketFile): Promise<void> {
  const dir = findTicketDir(ticketsDir, ticket.id);
  if (!dir) {
    throw new Error(`ticket dir not found for ${ticket.id}`);
  }
  const content = serializeTicket({
    id: ticket.id,
    frontmatter: ticket.frontmatter,
    body: ticket.body,
  });
  await writeFile(join(dir, 'ticket.md'), content, 'utf-8');
}

async function listReadyWithProject(ticketsDir: string): Promise<ParsedTicketFile[]> {
  const ready: ParsedTicketFile[] = [];
  for (const { id, ticketDir } of iterateAllTickets(ticketsDir)) {
    try {
      const raw = await readFile(join(ticketDir, 'ticket.md'), 'utf-8');
      const { frontmatter, body } = parseMarkdownTicket(raw);
      if (frontmatter.status !== 'ready') {
        continue;
      }
      const project = frontmatter.project?.trim();
      if (!project) {
        continue;
      }
      ready.push({ id, frontmatter: { ...frontmatter, id }, body });
    } catch (err) {
      logger.warn(`${TAG} skip ${ticketDir}:`, err);
    }
  }
  ready.sort((a, b) => a.id.localeCompare(b.id));
  return ready;
}

function jobOutcomeLine(job: JobRecord | undefined): string {
  if (!job) {
    return 'job unknown (not in scheduler)';
  }
  return `status=${job.status}, tasks ${job.tasksCompleted} ok / ${job.tasksFailed} fail / ${job.taskCount} total`;
}

export class RepeatingTicketDispatchHandler implements ActionHandler {
  readonly name = 'repeating_ticket_dispatch';

  async execute(ctx: ActionHandlerContext): Promise<string | undefined> {
    const params = this.parseParams(ctx.item.actionParams);
    const repeat = params.repeat ?? 5;
    const intervalMinutes = params.intervalMinutes ?? 30;

    let cluster: ClusterManager;
    try {
      cluster = getContainer().resolve<ClusterManager>(DITokens.CLUSTER_MANAGER);
    } catch {
      logger.error(`${TAG} ClusterManager not registered`);
      return '❌ repeating_ticket_dispatch: Agent Cluster 未启用（config/cluster）';
    }

    const ticketsDir = cluster.getTicketsDir();
    const clusterConfig = cluster.getConfig();
    const scheduler = cluster.getScheduler();

    const rounds: RoundDispatch[] = [];
    const start = Date.now();

    logger.info(`${TAG} Starting: repeat=${repeat}, interval=${intervalMinutes}min, ticketsDir=${ticketsDir}`);

    for (let round = 1; round <= repeat; round++) {
      if (round > 1) {
        await sleep(intervalMinutes * 60 * 1000);
      }

      const readyList = await listReadyWithProject(ticketsDir);
      if (readyList.length === 0) {
        rounds.push({ round, skipReason: 'no ready ticket with project' });
        logger.info(`${TAG} Round ${round}/${repeat}: no ready tickets`);
        continue;
      }

      const ticket = readyList[0];
      const project = ticket.frontmatter.project?.trim();
      if (!project) {
        rounds.push({ round, ticketId: ticket.id, error: 'project missing on ready ticket' });
        continue;
      }
      const tpl = ticket.frontmatter.template?.trim();
      const requirePlanner = isPlannerTemplate(clusterConfig, tpl);

      const description = buildClusterDescription(ticket.body, ticket.frontmatter);

      try {
        const task = await cluster.submitTask(project, description, {
          workerTemplate: tpl || undefined,
          requirePlannerRole: requirePlanner ? true : undefined,
          ticketId: ticket.id,
        });

        if (!task) {
          const msg = `submitTask returned null (project/template/scheduler rejected)`;
          rounds.push({ round, ticketId: ticket.id, error: msg });
          logger.warn(`${TAG} Round ${round}/${repeat}: ${msg}`);
          continue;
        }

        const jobId = task.jobId;
        const now = new Date().toISOString();
        const updated: ParsedTicketFile = {
          id: ticket.id,
          frontmatter: {
            ...ticket.frontmatter,
            status: 'dispatched',
            dispatchedJobId: jobId,
            project,
            updated: now,
          },
          body: ticket.body,
        };
        await writeTicketFile(ticketsDir, updated);

        rounds.push({ round, ticketId: ticket.id, jobId });
        logger.info(`${TAG} Round ${round}/${repeat}: dispatched ${ticket.id} → job ${jobId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rounds.push({ round, ticketId: ticket.id, error: msg });
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
        const job = scheduler.resolveJob(r.jobId);
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

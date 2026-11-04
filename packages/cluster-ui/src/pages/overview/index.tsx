/**
 * Overview answers three questions in order: does anything need me, is the system healthy, how
 * loaded is it. A healthy system takes no space, and every count is the length of the list under it.
 */

import type { ClusterTask } from '@qqbot/api-types';
import { AlertTriangle, ExternalLink, RotateCcw, Skull } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { createClusterJob, getClusterTask, getClusterTemplates, killClusterTask } from '../../api';
import { executionHref, routeHref } from '../../router';
import { ClusterStatusBadge } from '../execution/cluster/components/ClusterStatusBadge';
import { HelpRequestRow } from '../execution/cluster/components/HelpRequestRow';
import { KillConfirmDialog } from '../execution/cluster/components/KillConfirmDialog';
import { TaskOutputModal } from '../execution/cluster/components/TaskOutputModal';
import { formatTimestamp } from '../execution/cluster/utils';
import { resolveTemplateRole } from '../execution/tickets/utils';
import type { JobTask } from './attention';
import { type Overview, useOverview } from './useOverview';

/** The list routes cap `description`; a resubmission needs the whole prompt. */
async function resubmit(task: ClusterTask): Promise<void> {
  const [full, templates] = await Promise.all([getClusterTask(task.id), getClusterTemplates()]);
  const role = resolveTemplateRole(full.workerTemplate, templates);
  await createClusterJob({
    project: full.project,
    description: full.description,
    workerTemplate: full.workerTemplate,
    requirePlannerRole: role === 'planner' ? true : undefined,
  });
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs uppercase tracking-wide font-medium text-zinc-500 dark:text-zinc-400">
        {title}
        {typeof count === 'number' && <span className="ml-1.5 font-mono">({count})</span>}
      </h2>
      {children}
    </section>
  );
}

const ACTION_CLASS =
  'px-2 py-1 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1';

function TaskRow({ item, onOpen, children }: { item: JobTask; onOpen: () => void; children?: ReactNode }) {
  const { task, job } = item;
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 flex items-center gap-3 flex-wrap">
      <button type="button" onClick={onOpen} className="flex-1 min-w-[16rem] text-left flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <ClusterStatusBadge status={task.status} />
          <span className="font-mono">{task.project}</span>
          <span className="font-mono">{task.id.slice(0, 8)}</span>
          <span>{formatTimestamp(task.completedAt ?? task.createdAt)}</span>
        </span>
        <span className="text-sm text-zinc-900 dark:text-zinc-100 line-clamp-1">{task.description}</span>
        {task.error && <span className="text-xs text-red-600 dark:text-red-400 line-clamp-1">{task.error}</span>}
      </button>
      {job.ticketId && (
        <a href={executionHref('tickets', job.ticketId)} className={ACTION_CLASS}>
          <ExternalLink className="w-3 h-3" />
          Ticket
        </a>
      )}
      {children}
    </div>
  );
}

function SystemProblems({ overview }: { overview: Overview }) {
  const { cluster, health, error } = overview;
  const problems: ReactNode[] = [];
  if (error) {
    problems.push(`读取失败：${error}`);
  }
  if (health && !health.ok) {
    problems.push('Daemon /health 报告不健康。');
  }
  if (cluster && !cluster.started) {
    problems.push(
      <>
        Cluster 已停止，不会调度任务。到{' '}
        <a href={routeHref({ tab: 'settings' })} className="underline">
          Settings
        </a>{' '}
        启动。
      </>,
    );
  } else if (cluster?.status.paused) {
    problems.push(
      <>
        Cluster 已暂停，新任务不会派发。到{' '}
        <a href={routeHref({ tab: 'settings' })} className="underline">
          Settings
        </a>{' '}
        恢复。
      </>,
    );
  }
  if (problems.length === 0) {
    return null;
  }
  return (
    <Section title="系统问题" count={problems.length}>
      {problems.map((problem, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole on every render
          key={i}
          className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200 flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{problem}</span>
        </div>
      ))}
    </Section>
  );
}

function Load({ overview }: { overview: Overview }) {
  const status = overview.cluster?.status;
  if (!status) {
    return null;
  }
  return (
    <Section title="负载 · Worker" count={status.workers.length}>
      <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
        running tasks {status.runningTasks} · pending tasks {status.pendingTasks}
      </div>
      {status.workers.map((w) => (
        <a
          key={w.id}
          href={executionHref('workers')}
          className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 flex items-center gap-3 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
        >
          <ClusterStatusBadge status={w.status} />
          <span className="font-mono text-zinc-700 dark:text-zinc-200">{w.template}</span>
          <span className="font-mono text-zinc-500 dark:text-zinc-400">{w.project}</span>
          <span className="flex-1 min-w-0 truncate text-zinc-500 dark:text-zinc-400">{w.currentTaskDescription}</span>
        </a>
      ))}
    </Section>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  const { help, attention, refresh } = overview;

  const [openTask, setOpenTask] = useState<ClusterTask | null>(null);
  const [killTaskId, setKillTaskId] = useState<string | null>(null);
  const [resubmitting, setResubmitting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const needsMe = help.length + attention.stuck.length + attention.finished.length;
  const loaded = overview.cluster !== null;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-zinc-100 dark:bg-zinc-900">
      <div className="max-w-4xl mx-auto p-4 flex flex-col gap-6">
        {actionError && <div className="text-sm text-red-600 dark:text-red-400">{actionError}</div>}

        {loaded && needsMe === 0 && (
          <div className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">现在没有需要你处理的事。</div>
        )}
        {help.length > 0 && (
          <Section title="需要我 · 待回答" count={help.length}>
            {help.map((request) => (
              <HelpRequestRow key={request.id} request={request} onAnswered={refresh} />
            ))}
          </Section>
        )}
        {attention.stuck.length > 0 && (
          <Section title="需要我 · 受阻 / 失败（24h）" count={attention.stuck.length}>
            {attention.stuck.map((item) => (
              <TaskRow key={item.task.id} item={item} onOpen={() => setOpenTask(item.task)}>
                {item.task.status === 'blocked' && (
                  <button type="button" onClick={() => setKillTaskId(item.task.id)} className={ACTION_CLASS}>
                    <Skull className="w-3 h-3" />
                    Kill
                  </button>
                )}
                {!item.job.ticketId && (
                  <button
                    type="button"
                    disabled={resubmitting === item.task.id}
                    onClick={async () => {
                      setResubmitting(item.task.id);
                      await act(() => resubmit(item.task));
                      setResubmitting(null);
                    }}
                    className={ACTION_CLASS}
                  >
                    <RotateCcw className="w-3 h-3" />
                    重新提交
                  </button>
                )}
              </TaskRow>
            ))}
          </Section>
        )}
        {attention.finished.length > 0 && (
          <Section title="需要我 · 待查看结果（24h）" count={attention.finished.length}>
            {attention.finished.map((item) => (
              <TaskRow key={item.task.id} item={item} onOpen={() => setOpenTask(item.task)} />
            ))}
          </Section>
        )}

        <SystemProblems overview={overview} />
        <Load overview={overview} />
      </div>

      {openTask && <TaskOutputModal task={openTask} onClose={() => setOpenTask(null)} />}

      {killTaskId && (
        <KillConfirmDialog
          kind="task"
          id={killTaskId}
          onCancel={() => setKillTaskId(null)}
          onConfirm={async () => {
            const id = killTaskId;
            setKillTaskId(null);
            await act(() => killClusterTask(id));
          }}
        />
      )}
    </div>
  );
}

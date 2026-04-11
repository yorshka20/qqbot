import { ExternalLink, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getClusterJob } from '../../../api';
import type { ClusterJobWithTasks, ClusterTask, Ticket } from '../../../types';
import { orderTasksAsTree, TaskTreeRow } from '../../cluster/components/TaskTree';
import { TaskOutputModal } from '../../cluster/components/TaskOutputModal';
import { formatTicketTimestamp, ticketStatusBadgeClass } from '../utils';

/**
 * Detail panel for a single ticket. Renders below the tickets list when
 * a row is selected. Shows three things:
 *
 *   1. Ticket frontmatter summary (status / template / project / timestamps,
 *      plus planner-mode badge if usePlanner is set)
 *   2. The ticket body (markdown source, monospace, scrollable) — same
 *      content the worker received as its task prompt
 *   3. The associated cluster job's task tree (if dispatchedJobId is set):
 *      planner + child executors with status, output preview, click to
 *      open full task output in a modal
 *
 * Polls the cluster job every 3s while the job is non-terminal so the
 * user sees children appear / change status without manual refresh. The
 * poll stops once the job is `completed` or `failed`. Manual refresh
 * button is always available.
 *
 * Why not just deep-link to the cluster page: tickets are the user's
 * input artifact, the task tree is the immediate output. Bouncing
 * between two pages to correlate them is friction. The detail panel
 * keeps the original prompt and the live execution side by side.
 */
export function TicketDetailPanel({
  ticket,
  onClose,
}: {
  ticket: Ticket;
  /** Called when user clicks the close button. Parent should clear `selectedId`. */
  onClose: () => void;
}) {
  const [job, setJob] = useState<ClusterJobWithTasks | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskModal, setTaskModal] = useState<ClusterTask | null>(null);

  // Capture the dispatchedJobId once per ticket. Used by the polling
  // effect; gating both the fetch trigger and the polling teardown on
  // this avoids fetching for tickets that have never been dispatched.
  const dispatchedJobId = ticket.frontmatter.dispatchedJobId;

  const fetchJob = useCallback(async () => {
    if (!dispatchedJobId) return;
    setLoading(true);
    setError(null);
    try {
      const j = await getClusterJob(dispatchedJobId);
      setJob(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [dispatchedJobId]);

  // Refresh + poll while non-terminal. We use a ref-stored timer + a
  // dependency on `job?.status` so the polling loop re-evaluates after
  // each fetch — when the job transitions to terminal, the next interval
  // simply doesn't get scheduled.
  //
  // 3 second cadence is a balance between UI responsiveness and not
  // hammering the cluster API. The cluster scheduler tick itself is 30s,
  // so for source-driven tasks the user wouldn't notice anything faster.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dispatchedJobId) {
      setJob(null);
      return;
    }
    // Initial fetch on ticket switch.
    void fetchJob();
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [dispatchedJobId, fetchJob]);

  useEffect(() => {
    if (!job) return;
    const isTerminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
    if (isTerminal) return;
    pollTimerRef.current = setTimeout(() => {
      void fetchJob();
    }, 3_000);
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [job, fetchJob]);

  const fm = ticket.frontmatter;
  const treeRows = job ? orderTasksAsTree(job.tasks) : [];

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
        <div className="font-semibold text-zinc-900 dark:text-zinc-100 truncate min-w-0 flex-1">{fm.title}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono shrink-0">{fm.id}</div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-400"
          title="Close detail"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Frontmatter summary */}
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
        <div>
          <div className="text-zinc-500 dark:text-zinc-400 mb-0.5">status</div>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium ${ticketStatusBadgeClass(fm.status)}`}
          >
            {fm.status}
          </span>
        </div>
        <div>
          <div className="text-zinc-500 dark:text-zinc-400 mb-0.5">template</div>
          <div className="font-mono text-zinc-700 dark:text-zinc-200 truncate">{fm.template ?? '-'}</div>
        </div>
        <div>
          <div className="text-zinc-500 dark:text-zinc-400 mb-0.5">project</div>
          <div className="font-mono text-zinc-700 dark:text-zinc-200 truncate">{fm.project ?? '-'}</div>
        </div>
        <div>
          <div className="text-zinc-500 dark:text-zinc-400 mb-0.5">updated</div>
          <div className="font-mono text-zinc-700 dark:text-zinc-200">{formatTicketTimestamp(fm.updated)}</div>
        </div>
        {fm.usePlanner && (
          <div className="col-span-2 md:col-span-4">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase font-medium bg-purple-100 dark:bg-purple-950/50 text-purple-800 dark:text-purple-300">
              planner mode
              {fm.maxChildren ? ` · maxChildren=${fm.maxChildren}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Body — the prompt the worker actually receives */}
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          body (worker prompt — markdown verbatim)
        </div>
        <pre className="text-xs font-mono bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded p-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-200">
          {ticket.body || <span className="italic text-zinc-400">(empty body)</span>}
        </pre>
      </div>

      {/* Cluster job task tree (only if dispatched) */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">cluster job</div>
          {dispatchedJobId ? (
            <>
              <div className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {dispatchedJobId.slice(0, 8)}
              </div>
              {job && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                  {job.tasksCompleted}✓ {job.tasksFailed}✗ /{job.taskCount}
                </div>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => void fetchJob()}
                disabled={loading}
                className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 disabled:opacity-30"
                title="Refresh task tree"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <a
                href={`#/cluster?job=${encodeURIComponent(dispatchedJobId)}`}
                className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 inline-flex"
                title="Open in Cluster page"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </>
          ) : (
            <div className="text-xs text-zinc-500 dark:text-zinc-400 italic">
              not dispatched yet — click the dispatch button on the row above
            </div>
          )}
        </div>

        {dispatchedJobId && error && (
          <div className="text-xs text-red-600 dark:text-red-400 mb-2">
            Failed to load cluster job: {error}. The job may have been dropped from memory after a cluster
            restart, or the cluster might be stopped.
          </div>
        )}

        {dispatchedJobId && !job && !error && loading && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">Loading task tree…</div>
        )}

        {dispatchedJobId && job && job.tasks.length === 0 && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 italic">
            Job has no tasks recorded (cluster may have restarted before tasks were persisted).
          </div>
        )}

        {dispatchedJobId && job && treeRows.length > 0 && (
          <div className="flex flex-col gap-1">
            {treeRows.map(({ task, depth }) => (
              <TaskTreeRow key={task.id} task={task} depth={depth} onClick={setTaskModal} />
            ))}
          </div>
        )}

        {dispatchedJobId && job && (job.status === 'completed' || job.status === 'failed') && (
          <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400 italic">
            Job is in terminal state. To capture the result back into this ticket, edit the ticket and
            paste the relevant child outputs into a "## Result" section in the body.
          </div>
        )}
      </div>

      {/* Task output modal — shared with the cluster page */}
      {taskModal && <TaskOutputModal task={taskModal} onClose={() => setTaskModal(null)} />}
    </div>
  );
}

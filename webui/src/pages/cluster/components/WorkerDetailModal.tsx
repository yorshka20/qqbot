import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getClusterTask } from '../../../api';
import type { ClusterTask, ClusterWorkerHistoryEntry, EnrichedWorkerRegistration } from '../../../types';
import { formatEpoch, formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';
import { Modal } from './Modal';

interface WorkerDetailModalProps {
  worker: ClusterWorkerHistoryEntry | EnrichedWorkerRegistration | null;
  onClose: () => void;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '' || value === '-') return null;
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="shrink-0 w-32 text-zinc-500 dark:text-zinc-400 font-medium">{label}</span>
      <span className="flex-1 min-w-0 text-zinc-800 dark:text-zinc-100 font-mono break-all">{value}</span>
    </div>
  );
}

function Block({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium mb-1">
        {label}
      </div>
      <div className="text-xs text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap break-words bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded p-2">
        {value}
      </div>
    </div>
  );
}

export function WorkerDetailModal({ worker, onClose }: WorkerDetailModalProps) {
  const [task, setTask] = useState<ClusterTask | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);

  useEffect(() => {
    if (!worker) return;
    const taskId = worker.lastBoundTaskId ?? worker.currentTaskId;
    if (!taskId) return;

    setTaskLoading(true);
    setTaskError(null);
    setTask(null);
    getClusterTask(taskId)
      .then((raw) => {
        const { children, ...t } = raw as ClusterTask & { children?: unknown };
        void children;
        setTask(t);
      })
      .catch((e) => {
        setTaskError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setTaskLoading(false);
      });
  }, [worker]);

  if (!worker) return null;

  const registeredAt = worker.stats?.registeredAt ?? worker.spawnedAt;

  const header = (
    <>
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 font-mono truncate min-w-0">
        {worker.workerId ?? 'Worker Detail'}
      </h2>
      {worker.role && (
        <span className="shrink-0 px-2 py-0.5 rounded bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 text-xs font-mono">
          {worker.role}
        </span>
      )}
      <ClusterStatusBadge status={worker.status ?? 'unknown'} />
    </>
  );

  return (
    <Modal onClose={onClose} header={header} size="md" zIndex={60}>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
        {/* Worker metadata grid (short scalar fields) */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700">
          <Field label="workerId" value={worker.workerId} />
          <Field label="role" value={worker.role} />
          <Field label="project" value={worker.project} />
          <Field label="templateName" value={worker.templateName} />
          <Field label="status" value={worker.status} />
          <Field label="lastReportStatus" value={worker.lastReportStatus} />
          <Field label="registeredAt" value={formatEpoch(registeredAt)} />
          <Field label="exitedAt" value={formatEpoch(worker.exitedAt)} />
          <Field label="lastSeen" value={formatEpoch(worker.lastSeen)} />
          <Field label="lastHubReportAt" value={formatEpoch(worker.lastHubReportAt)} />
          <Field label="syncCursor" value={worker.syncCursor != null ? String(worker.syncCursor) : undefined} />
          <Field label="boundJobId" value={worker.boundJobId} />
          <Field label="lastBoundTaskId" value={worker.lastBoundTaskId} />
          {worker.stats && (
            <>
              <Field
                label="tasksCompleted"
                value={worker.stats.tasksCompleted != null ? String(worker.stats.tasksCompleted) : undefined}
              />
              <Field
                label="tasksFailed"
                value={worker.stats.tasksFailed != null ? String(worker.stats.tasksFailed) : undefined}
              />
              <Field
                label="totalReports"
                value={worker.stats.totalReports != null ? String(worker.stats.totalReports) : undefined}
              />
            </>
          )}
        </div>

        {/* Full-width report blocks */}
        <div className="space-y-3">
          <Block label="Last Report Summary" value={worker.lastReportSummary} />
          <Block label="Last Report Next Steps" value={worker.lastReportNextSteps} />
        </div>

        {/* Task output section */}
        {(taskLoading || task || taskError) && (
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2 font-medium">
              Last Bound Task
            </div>

            {taskLoading && (
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading task...
              </div>
            )}

            {taskError && <div className="text-xs text-red-600 dark:text-red-400">{taskError}</div>}

            {task && (
              <div className="space-y-3 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{task.id.slice(0, 8)}</span>
                  <ClusterStatusBadge status={task.status} />
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {formatTimestamp(task.createdAt)}
                    {task.completedAt ? ` → ${formatTimestamp(task.completedAt)}` : ''}
                  </span>
                </div>

                {task.diffSummary && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">Summary</div>
                    <div className="text-xs text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap break-words">
                      {task.diffSummary}
                    </div>
                  </div>
                )}

                {task.error && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-red-500 mb-1">Error</div>
                    <pre className="text-xs whitespace-pre-wrap break-words bg-red-50 dark:bg-red-950/30 p-2 rounded text-red-700 dark:text-red-300">
                      {task.error}
                    </pre>
                  </div>
                )}

                {task.output && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setOutputExpanded((v) => !v)}
                      className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                    >
                      {outputExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      Worker CLI Output ({(task.output.length / 1024).toFixed(1)}KB)
                    </button>
                    {outputExpanded && (
                      <pre className="mt-1 text-xs whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-800 dark:text-zinc-100 max-h-[40vh] overflow-y-auto border border-zinc-200 dark:border-zinc-700">
                        {task.output}
                      </pre>
                    )}
                  </div>
                )}

                {task.description && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setDescExpanded((v) => !v)}
                      className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                    >
                      {descExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      Task Description
                    </button>
                    {descExpanded && (
                      <pre className="mt-1 text-xs whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-800 dark:text-zinc-100 max-h-[40vh] overflow-y-auto border border-zinc-200 dark:border-zinc-700">
                        {task.description}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

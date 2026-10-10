import { Bot, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelAgentTask,
  getAgentsStatus,
  getAgentTask,
  getAgentTaskEvents,
  getAgentTaskOutput,
  listAgentTasks,
} from '../../api';
import type { AgentsStatusResponse, AgentTaskEvent, AgentTaskOutput, AgentTaskRecord } from '../../types';
import { AgentTaskDetail } from './components/AgentTaskDetail';
import { AgentTaskList } from './components/AgentTaskList';

/** The task list and the service state are polled at this rate while the page is open. */
const LIST_POLL_MS = 3_000;

/**
 * Coding-agent tasks: what `/claude`, `/codex`, `/dsh` and `delegate_agent_task` ran, how
 * each went, and what the CLI printed. Read-only by design — dispatch stays in chat,
 * because only the chat knows which conversation a result belongs to.
 *
 * The list polls continuously so a task started from chat shows up here on its own. A
 * selected task's detail, timeline and transcript are polled only while it is still
 * running; once it ends the effect re-runs for one final read and then stops, since a
 * finished task's transcript cannot change.
 */
export function AgentsPage() {
  const [status, setStatus] = useState<AgentsStatusResponse | null>(null);
  const [tasks, setTasks] = useState<AgentTaskRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentTaskRecord | null>(null);
  const [events, setEvents] = useState<AgentTaskEvent[]>([]);
  const [output, setOutput] = useState<AgentTaskOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingDetail, setRefreshingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const selectionRef = useRef<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextTasks] = await Promise.all([getAgentsStatus(), listAgentTasks({ limit: 200 })]);
      setStatus(nextStatus);
      setTasks(nextTasks.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
    const timer = window.setInterval(loadList, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadList]);

  // Ticks the duration shown on running rows between list polls.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const selectedRunning = selected?.status === 'running';

  const loadDetail = useCallback(async (id: string, viaButton = false) => {
    if (viaButton) {
      setRefreshingDetail(true);
    }
    try {
      const [task, timeline, transcript] = await Promise.all([
        getAgentTask(id),
        getAgentTaskEvents(id),
        getAgentTaskOutput(id),
      ]);
      // A poll for a task the user has since deselected must not overwrite the new view.
      if (selectionRef.current !== id) {
        return;
      }
      setDetail(task);
      setEvents(timeline);
      setOutput(transcript);
      setError(null);
    } catch (err) {
      if (selectionRef.current === id) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (viaButton) {
        setRefreshingDetail(false);
      }
    }
  }, []);

  useEffect(() => {
    selectionRef.current = selectedId;
    if (!selectedId) {
      setDetail(null);
      setEvents([]);
      setOutput(null);
      return;
    }

    loadDetail(selectedId);
    if (!selectedRunning) {
      return;
    }
    const timer = window.setInterval(() => loadDetail(selectedId), LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedId, selectedRunning, loadDetail]);

  const handleCancel = useCallback(
    async (id: string) => {
      try {
        await cancelAgentTask(id);
        await Promise.all([loadList(), loadDetail(id, true)]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadList, loadDetail],
  );

  const enabled = status?.enabled ?? false;
  const executorNames = (status?.executors ?? []).map((e) => e.displayName).join(' · ');

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full flex flex-col">
        <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
              <div className="font-semibold">Agent Tasks</div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              {tasks.length} task{tasks.length === 1 ? '' : 's'}
              {enabled && status?.runningTasks !== undefined
                ? ` · 运行中 ${status.runningTasks} · 排队 ${status.pendingTasks ?? 0}`
                : ''}
            </div>
            {enabled && executorNames && (
              <div className="text-xs text-zinc-400 dark:text-zinc-500">{executorNames}</div>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={loadList}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          {!enabled && status !== null && (
            <div className="mt-2 text-sm text-amber-600 dark:text-amber-400">
              Coding agent 服务未启用（config 里 <span className="font-mono">codingAgent.enabled</span> 为 false），
              下面是历史记录。
            </div>
          )}
          {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>

        <div className="flex-1 min-h-0 flex bg-zinc-100 dark:bg-zinc-900">
          <div className="flex-1 min-w-0 basis-1/2 border-r border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-y-auto">
            <AgentTaskList tasks={tasks} selectedId={selectedId} now={now} onSelect={setSelectedId} />
          </div>

          <div className="flex-1 min-w-0 basis-1/2 overflow-y-auto p-4">
            {detail ? (
              <AgentTaskDetail
                task={detail}
                events={events}
                output={output}
                now={now}
                refreshing={refreshingDetail}
                onRefresh={() => loadDetail(detail.id, true)}
                onCancel={handleCancel}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
                从左边选一个任务查看进度、时间线和输出。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

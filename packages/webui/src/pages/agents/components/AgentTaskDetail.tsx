import { Ban, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { AgentTaskEvent, AgentTaskOutput, AgentTaskRecord } from '../../../types';
import {
  agentEventLabel,
  agentStatusBadgeClass,
  agentStatusLabel,
  describeRequester,
  formatClock,
  formatDuration,
  formatTimestamp,
} from '../utils';

/** Read-only view of one task: what was asked, how it went, and what the CLI printed. */
export function AgentTaskDetail({
  task,
  events,
  output,
  now,
  refreshing,
  onRefresh,
  onCancel,
}: {
  task: AgentTaskRecord;
  events: AgentTaskEvent[];
  output: AgentTaskOutput | null;
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
  onCancel: (id: string) => void;
}) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const transcript = output?.[stream] ?? '';
  const truncated = stream === 'stdout' ? output?.stdoutTruncated : output?.stderrTruncated;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${agentStatusBadgeClass(task.status)}`}>
            {agentStatusLabel(task.status)}
          </span>
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{task.executor}</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
            {task.model}
            {task.effort ? ` · ${task.effort}` : ''}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="px-2 py-1 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
          {task.status === 'running' && (
            <button
              type="button"
              onClick={() => onCancel(task.id)}
              className="px-2 py-1 rounded-lg text-xs font-medium border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors flex items-center gap-1.5"
            >
              <Ban className="w-3.5 h-3.5" />
              取消
            </button>
          )}
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3 text-xs">
          <dt className="text-zinc-500 dark:text-zinc-400">任务 ID</dt>
          <dd className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{task.id}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">请求者</dt>
          <dd className="text-zinc-700 dark:text-zinc-300">{describeRequester(task)}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">类型</dt>
          <dd className="text-zinc-700 dark:text-zinc-300">
            {task.taskType}
            {task.projectAlias ? ` · ${task.projectAlias}` : ''}
          </dd>
          <dt className="text-zinc-500 dark:text-zinc-400">工作目录</dt>
          <dd className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{task.workingDirectory}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">时间</dt>
          <dd className="text-zinc-700 dark:text-zinc-300">
            {formatTimestamp(task.createdAt)} → {formatTimestamp(task.finishedAt)} · {formatDuration(task, now)}
          </dd>
          <dt className="text-zinc-500 dark:text-zinc-400">记录目录</dt>
          <dd className="font-mono text-zinc-700 dark:text-zinc-300 break-all">{task.directory}</dd>
        </dl>

        {(task.error || task.result) && (
          <div className="mt-3">
            <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              {task.error ? '错误' : '结果'}
            </div>
            <pre
              className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 text-xs ${
                task.error
                  ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                  : 'bg-zinc-50 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200'
              }`}
            >
              {task.error || task.result}
            </pre>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">任务要求</div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-50 dark:bg-zinc-900 p-3 text-xs text-zinc-800 dark:text-zinc-200">
          {task.prompt}
        </pre>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
          时间线 <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">({events.length})</span>
        </div>
        {events.length === 0 ? (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">没有记录</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((event) => (
              // Two events can share a millisecond; kind and message make the key identify the row.
              <li key={`${event.at}-${event.kind}-${event.message ?? ''}`} className="flex items-start gap-2 text-xs">
                <span className="font-mono text-zinc-400 dark:text-zinc-500 shrink-0">{formatClock(event.at)}</span>
                <span className="px-1.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 shrink-0">
                  {agentEventLabel(event.kind)}
                </span>
                <span className="text-zinc-700 dark:text-zinc-300 break-words">{event.message ?? ''}</span>
                {event.progress !== undefined && (
                  <span className="font-mono text-zinc-400 dark:text-zinc-500 shrink-0">{event.progress}%</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">输出</div>
          {(['stdout', 'stderr'] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setStream(name)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                stream === name
                  ? 'bg-zinc-200 dark:bg-zinc-600 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700'
              }`}
            >
              {name}
            </button>
          ))}
          {truncated && <span className="text-[11px] text-amber-600 dark:text-amber-400">只显示末尾部分</span>}
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-900 dark:bg-black p-3 text-[11px] leading-relaxed text-zinc-200">
          {transcript || '（还没有输出）'}
        </pre>
      </div>
    </div>
  );
}

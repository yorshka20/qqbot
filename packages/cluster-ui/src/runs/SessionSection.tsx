import type { ClusterTaskDetail } from '@qqbot/api-types';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { copyText } from '../lib/clipboard';
import { resumeCommand } from '../lib/resume';

const COPIED_MS = 1500;

function Fact({ label, value }: { label: string; value: string | number }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(String(value))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    }
  };

  return (
    <div className="flex items-baseline gap-3 text-14">
      <span className="w-16 shrink-0 text-ink-muted">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-13 break-all">{value}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`复制${label}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-ui px-1.5 py-0.5 text-12 text-ink-muted hover:bg-surface-2"
      >
        <Copy className="size-3.5" />
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

export function SessionSection({ task }: { task: ClusterTaskDetail }) {
  const { templates, projects } = useCluster();

  const templateType = templates?.templates.find((t) => t.name === task.workerTemplate)?.type;
  const projectPath = projects?.projects.find((p) => p.alias === task.project)?.path;
  const command = resumeCommand(templateType, task.sessionId, projectPath);

  if (!task.workerId && !task.model) {
    return null;
  }

  return (
    <details className="mb-8">
      <summary className="min-h-7 cursor-pointer text-14 font-medium tracking-wide text-ink-muted">会话</summary>
      <div className="mt-2 flex flex-col gap-1">
        {task.workerId && <Fact label="worker" value={task.workerId} />}
        {task.workerPid !== undefined && <Fact label="pid" value={task.workerPid} />}
        {task.sessionId && <Fact label="session" value={task.sessionId} />}
        {task.model && <Fact label="模型 id" value={task.model} />}
        {task.logPath && <Fact label="日志文件" value={task.logPath} />}
        {command && <Fact label="续跑命令" value={command} />}
      </div>
    </details>
  );
}

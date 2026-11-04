import type { ClusterTaskDetail } from '@qqbot/api-types';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { copyText } from '../lib/clipboard';
import { resumeCommand } from '../lib/resume';
import { Button } from '../ui/Button';
import { Section } from '../ui/Section';

const COPIED_MS = 1500;

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex gap-3 text-14">
      <span className="w-16 shrink-0 text-ink-muted">{label}</span>
      <span className="min-w-0 font-mono text-13 break-all">{value}</span>
    </div>
  );
}

export function SessionSection({ task }: { task: ClusterTaskDetail }) {
  const { templates, projects } = useCluster();
  const [copied, setCopied] = useState(false);

  const templateType = templates?.templates.find((t) => t.name === task.workerTemplate)?.type;
  const projectPath = projects?.projects.find((p) => p.alias === task.project)?.path;
  const command = resumeCommand(templateType, task.sessionId, projectPath);

  const copy = async () => {
    if (command && (await copyText(command))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    }
  };

  if (!task.workerId) {
    return null;
  }

  return (
    <Section
      title="会话"
      aside={
        command && (
          <Button onClick={copy}>
            <Copy className="size-3.5" />
            {copied ? '已复制' : '复制续跑命令'}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-0.5">
        <Fact label="worker" value={task.workerId} />
        {task.workerPid !== undefined && <Fact label="pid" value={task.workerPid} />}
        {task.sessionId && <Fact label="session" value={task.sessionId} />}
        {task.logPath && <Fact label="日志文件" value={task.logPath} />}
        {command && <Fact label="续跑" value={command} />}
      </div>
    </Section>
  );
}

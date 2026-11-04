import type { ClusterTaskDetail } from '@qqbot/api-types';
import { Check, ChevronDown, ChevronRight, Copy, Maximize2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { Markdown } from '../components/Markdown';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { ScrollArea } from '../components/ui/scroll-area';
import { copyText } from '../lib/clipboard';
import { resumeCommand } from '../lib/resume';
import { runBody } from '../lib/runs';
import { usageFacts } from '../lib/usage';
import { LogView } from './LogView';

function Fact({ label, value, copyable = false }: { label: string; value: string | number; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(String(value))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-xs break-all">{value}</span>
      {copyable && (
        <Button variant="ghost" size="xs" onClick={copy} aria-label={`复制${label}`}>
          {copied ? <Check /> : <Copy />}
          {copied ? '已复制' : '复制'}
        </Button>
      )}
    </div>
  );
}

function Section({
  title,
  defaultOpen = true,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b py-2">
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="font-medium">
            <Chevron />
            {title}
          </Button>
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent className="px-2 pt-2 pb-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function DetailPanel({
  task,
  live,
  onOpenLog,
}: {
  task: ClusterTaskDetail;
  live: boolean;
  onOpenLog: () => void;
}) {
  const { templates, projects } = useCluster();
  const templateType = templates?.templates.find((template) => template.name === task.workerTemplate)?.type;
  const projectPath = projects?.projects.find((project) => project.alias === task.project)?.path;
  const command = resumeCommand(templateType, task.sessionId, projectPath);
  const usage = usageFacts(task.usage);
  const body = runBody(task.description);

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col px-2">
        <Section title="任务描述">
          {body ? (
            <div className="max-h-96 overflow-auto">
              <Markdown>{body}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">没有描述。</p>
          )}
        </Section>
        <Section title="会话">
          <div className="flex flex-col gap-1">
            {task.workerId && <Fact label="worker" value={task.workerId} copyable />}
            {task.workerPid !== undefined && <Fact label="pid" value={task.workerPid} copyable />}
            {task.sessionId && <Fact label="session" value={task.sessionId} copyable />}
            {task.model && <Fact label="模型 id" value={task.model} copyable />}
            <Fact label="context" value={usage.context} />
            <Fact label="输入" value={usage.input} />
            <Fact label="输出" value={usage.output} />
            <Fact label="轮数" value={usage.turns} />
            <Fact label="成本" value={usage.cost ?? '未知'} />
            {command ? (
              <Fact label="续跑命令" value={command} copyable />
            ) : (
              <Fact label="续跑命令" value="这个后端不支持续跑" />
            )}
          </div>
        </Section>
        <Section
          title="日志"
          action={
            <Button variant="ghost" size="icon-sm" onClick={onOpenLog} aria-label="全屏查看日志">
              <Maximize2 />
            </Button>
          }
        >
          <LogView taskId={task.id} live={live} logPath={task.logPath} className="h-80" />
        </Section>
      </div>
    </ScrollArea>
  );
}

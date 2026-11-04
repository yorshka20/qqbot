import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { navigate, routeHref } from '../app/route';
import type { InboxItem } from '../lib/inbox';
import { markSeen } from '../lib/memory';
import type { Tone } from '../lib/stage';
import { formatWait } from '../lib/time';
import { AnswerBox } from '../runs/AnswerBox';
import { retryRun } from '../runs/submitRun';
import { Button } from '../ui/Button';
import { STAGE_ICON, StatePill } from '../ui/StatePill';
import { StatusBar } from '../ui/StatusBar';

const KIND: Record<InboxItem['kind'], { label: string; tone: Tone; icon: LucideIcon }> = {
  ask: { label: '等你回答', tone: 'attention', icon: STAGE_ICON.asking },
  failed: { label: '失败', tone: 'failed', icon: STAGE_ICON.failed },
  review: { label: '待查看', tone: 'done', icon: STAGE_ICON.review },
};

function FailedActions({ item }: { item: Extract<InboxItem, { kind: 'failed' }> }) {
  const { templates, refresh } = useCluster();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const task = await retryRun(item.run, templates);
      await refresh();
      navigate(routeHref({ section: 'runs', runId: task.id }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button variant="solid" disabled={busy} onClick={retry} title="用同样的描述重新提交一条运行">
        重试这条运行
      </Button>
      <Button onClick={() => markSeen(item.run.task.id)}>标记已看</Button>
      {error && <p className="text-13 text-failed">{error}</p>}
    </div>
  );
}

export function InboxRow({
  item,
  index,
  href,
  now,
  selected,
  cursor,
}: {
  item: InboxItem;
  index: number;
  href: string;
  now: number;
  selected: boolean;
  cursor: boolean;
}) {
  const { label, tone, icon } = KIND[item.kind];
  const title = item.kind === 'ask' ? (item.run?.title ?? item.help.question) : item.run.title;
  const run = item.run;
  const linked = item.kind !== 'ask' || run !== undefined;

  const head = (
    <>
      <div className="flex items-center justify-between gap-3">
        <StatePill tone={tone} label={label} icon={icon} />
        <span className="text-18 font-medium text-attention">{formatWait(now - item.since)}</span>
      </div>
      <div className="truncate text-16">{title}</div>
      {run && (
        <div className="truncate text-14 text-ink-muted">
          {[run.task.project, run.task.workerTemplate].filter(Boolean).join(' · ')}
        </div>
      )}
    </>
  );

  return (
    <div
      data-row={index}
      className={`relative border-b border-line/60 px-4 py-3 pl-5 ${item.kind === 'ask' ? 'bg-attention/5' : ''} ${
        cursor ? 'bg-surface-2/50' : ''
      }`}
    >
      <StatusBar tone={tone} active={selected} />
      {linked ? (
        <a href={href} className="block">
          {head}
        </a>
      ) : (
        head
      )}
      {item.kind === 'ask' && item.run && <p className="mt-1.5 line-clamp-3 text-15">「{item.help.question}」</p>}
      {item.kind === 'failed' && item.run.task.error && (
        <p className="mt-1.5 line-clamp-2 text-14 text-ink-muted">{item.run.task.error}</p>
      )}
      <div className="mt-3 border-t border-line/60 pt-3">
        {item.kind === 'ask' && <AnswerBox askId={item.help.id} options={item.help.options} compact />}
        {item.kind === 'failed' && <FailedActions item={item} />}
        {item.kind === 'review' && <Button onClick={() => markSeen(item.run.task.id)}>标记已看</Button>}
      </div>
    </div>
  );
}

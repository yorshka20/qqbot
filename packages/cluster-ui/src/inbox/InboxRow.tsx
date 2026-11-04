import { useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { navigate, routeHref } from '../app/route';
import type { InboxItem } from '../lib/inbox';
import { markSeen } from '../lib/memory';
import { TONE_BG, TONE_TEXT, type Tone } from '../lib/stage';
import { formatWait } from '../lib/time';
import { AnswerBox } from '../runs/AnswerBox';
import { retryRun } from '../runs/submitRun';
import { Button } from '../ui/Button';

const KIND: Record<InboxItem['kind'], { label: string; tone: Tone }> = {
  ask: { label: '等你回答', tone: 'attention' },
  failed: { label: '失败', tone: 'failed' },
  review: { label: '待查看', tone: 'done' },
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
    <div className="mt-1.5 -ml-2.5">
      <Button disabled={busy} onClick={retry} title="用同样的描述重新提交一条运行">
        重试这条运行
      </Button>
      <Button onClick={() => markSeen(item.run.task.id)}>标记已看</Button>
      {error && <p className="ml-2.5 text-13 text-failed">{error}</p>}
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
  const { label, tone } = KIND[item.kind];
  const title = item.kind === 'ask' ? (item.run?.title ?? item.help.question) : item.run.title;
  const run = item.run;
  const linked = item.kind !== 'ask' || run !== undefined;

  const head = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-17 font-medium text-attention">{formatWait(now - item.since)}</span>
        <span className={`text-13 ${TONE_TEXT[tone]}`}>{label}</span>
      </div>
      <div className="truncate text-15">{title}</div>
      {run && (
        <div className="truncate text-13 text-ink-muted">
          {[run.task.project, run.task.workerTemplate].filter(Boolean).join(' · ')}
        </div>
      )}
    </>
  );

  return (
    <div data-row={index} className={`relative px-4 py-3 ${cursor ? 'bg-surface-2/50' : ''}`}>
      {selected && <span className={`absolute inset-y-0 left-0 w-0.5 ${TONE_BG[tone]}`} />}
      {linked ? (
        <a href={href} className="block">
          {head}
        </a>
      ) : (
        head
      )}
      {item.kind === 'ask' && (
        <>
          {item.run && <p className="mt-1.5 text-15">「{item.help.question}」</p>}
          <div className="mt-2">
            <AnswerBox askId={item.help.id} options={item.help.options} compact />
          </div>
        </>
      )}
      {item.kind === 'failed' && (
        <>
          {item.run.task.error && <p className="mt-1 line-clamp-2 text-13 text-ink-muted">{item.run.task.error}</p>}
          <FailedActions item={item} />
        </>
      )}
      {item.kind === 'review' && (
        <div className="mt-1.5 -ml-2.5">
          <Button onClick={() => markSeen(item.run.task.id)}>标记已看</Button>
        </div>
      )}
    </div>
  );
}

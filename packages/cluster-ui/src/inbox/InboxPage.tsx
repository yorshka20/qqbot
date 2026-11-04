import { Check, ChevronDown, ChevronRight, MessageCircleQuestion, RotateCcw, TriangleAlert } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { acknowledgeClusterTask } from '../api';
import { useCluster } from '../app/ClusterData';
import { useListCursor } from '../app/keys';
import { AnswerForm } from '../components/AnswerForm';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Skeleton } from '../components/ui/skeleton';
import { failureReason } from '../lib/conversation';
import { type ArchiveItem, buildInbox, buildInboxArchive, groupInboxByDay, type InboxItem } from '../lib/inbox';
import { taskPath } from '../lib/routes';
import type { Run } from '../lib/runs';
import { STAGE_LABEL } from '../lib/stage';
import { pathOfRun } from '../lib/taskList';
import { formatClock, formatWait } from '../lib/time';
import { useNow } from '../lib/useNow';
import { cn } from '../lib/utils';
import { retryRun } from '../runs/submitRun';

const ARCHIVE_LABEL: Record<ArchiveItem['kind'], string> = {
  answered: '已回答',
  failed: '失败已看',
  review: '结果已看',
};

function chatPathOfRun(run: Run, runs: Run[]): string {
  const path = pathOfRun(run, runs);
  return `${path}${path.includes('?') ? '&' : '?'}tab=chat`;
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function SeenButton({ taskId }: { taskId: string }) {
  const { refresh } = useCluster();
  const { busy, error, run } = useAction();
  return (
    <>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await acknowledgeClusterTask(taskId);
            await refresh();
          })
        }
      >
        <Check />
        标记已看
      </Button>
      {error && <p className="text-xs break-words text-failed">{error}</p>}
    </>
  );
}

function RetryButton({ run }: { run: Run }) {
  const { templates, refresh } = useCluster();
  const navigate = useNavigate();
  const { busy, error, run: act } = useAction();
  return (
    <>
      <Button
        disabled={busy}
        onClick={() =>
          act(async () => {
            const { task } = await retryRun(run, templates);
            await refresh();
            navigate(taskPath(task.id));
          })
        }
      >
        <RotateCcw />
        重试这条运行
      </Button>
      {error && <p className="text-xs break-words text-failed">{error}</p>}
    </>
  );
}

function itemHref(item: InboxItem, runs: Run[]): string | null {
  if (item.kind === 'ask') {
    if (item.run) {
      return chatPathOfRun(item.run, runs);
    }
    return item.help.taskId ? taskPath(item.help.taskId, 'chat') : null;
  }
  return chatPathOfRun(item.run, runs);
}

function archiveHref(item: ArchiveItem, runs: Run[]): string | null {
  if (item.run) {
    return chatPathOfRun(item.run, runs);
  }
  return item.taskId ? taskPath(item.taskId, 'chat') : null;
}

function MaybeLink({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? (
    <Link to={href} className="block">
      {children}
    </Link>
  ) : (
    <div>{children}</div>
  );
}

function PendingRow({
  item,
  href,
  index,
  cursor,
  now,
}: {
  item: InboxItem;
  href: string | null;
  index: number;
  cursor: boolean;
  now: number;
}) {
  const Icon = item.kind === 'ask' ? MessageCircleQuestion : TriangleAlert;
  const label =
    item.kind === 'ask'
      ? STAGE_LABEL.asking
      : item.kind === 'failed'
        ? STAGE_LABEL[item.run.stage]
        : STAGE_LABEL.review;
  const tone = item.kind === 'failed' ? 'text-failed' : item.kind === 'ask' ? 'text-attention' : 'text-done';
  const run = item.run;
  const title = item.kind === 'ask' ? (run?.title ?? item.help.question) : item.run.title;
  const reason =
    item.kind === 'failed'
      ? failureReason({ taskError: item.run.task.error, output: item.run.task.output })
      : undefined;

  return (
    <div
      data-row={index}
      className={cn('space-y-3 border-b px-4 py-3', item.kind === 'ask' && 'bg-attention/5', cursor && 'bg-muted/60')}
    >
      <MaybeLink href={href}>
        <div className="flex items-center justify-between gap-3">
          <span className={cn('flex items-center gap-1.5 text-sm', tone)}>
            <Icon className="size-4" />
            {label}
          </span>
          <span className="text-lg font-medium text-attention">{formatWait(now - item.since)}</span>
        </div>
        <div className="mt-1 truncate font-medium">{title}</div>
        {run && (
          <div className="truncate text-sm text-muted-foreground">
            {[run.task.project, run.task.workerTemplate].filter(Boolean).join(' · ')}
          </div>
        )}
        {item.kind === 'ask' && <p className="mt-1 line-clamp-3 text-sm">「{item.help.question}」</p>}
        {reason && <p className="mt-1 line-clamp-3 text-sm break-words text-muted-foreground">{reason}</p>}
      </MaybeLink>
      {item.kind === 'ask' ? (
        <AnswerForm askId={item.help.id} options={item.help.options} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {item.kind === 'failed' && <RetryButton run={item.run} />}
          <SeenButton taskId={item.run.task.id} />
        </div>
      )}
    </div>
  );
}

function Archive({ archive, runs, now }: { archive: ArchiveItem[]; runs: Run[]; now: number }) {
  const [open, setOpen] = useState(true);
  const groups = groupInboxByDay(
    archive.map((item) => ({ item, since: item.at })),
    now,
  ).reverse();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="ml-2">
          <Chevron />
          已处理 · {archive.length}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground">{group.label}</div>
            {group.items.map(({ item }) => (
              <div key={item.id} className="border-b px-4 py-2">
                <MaybeLink href={archiveHref(item, runs)}>
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatClock(item.at, now)} · {ARCHIVE_LABEL[item.kind]}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  </div>
                  {item.help && (
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      问：{item.help.question} / 答：{item.help.answer}
                      {item.answeredBy && ` / 回答人：${item.answeredBy}`}
                    </p>
                  )}
                </MaybeLink>
              </div>
            ))}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function InboxPage() {
  const { loaded, runs, help, helpHistory } = useCluster();
  const now = useNow();
  const navigate = useNavigate();
  const items = useMemo(() => buildInbox(runs, help, null), [runs, help]);
  const archive = useMemo(() => buildInboxArchive(runs, helpHistory), [runs, helpHistory]);
  const groups = groupInboxByDay(items, now);
  const hrefs = groups.flatMap((group) => group.items).map((item) => itemHref(item, runs));
  const { cursor } = useListCursor(
    hrefs.map((href) => href ?? ''),
    (href) => {
      if (href) {
        navigate(href);
      }
    },
  );

  if (!loaded) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  let index = -1;
  return (
    <div className="mx-auto w-full max-w-measure pb-6">
      <h1 className="px-4 pt-4 pb-3 text-lg font-medium">{items.length > 0 ? `${items.length} 件需要你` : '收件箱'}</h1>
      {items.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">没有需要你的事。</p>}
      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground">{group.label}</div>
          {group.items.map((item) => {
            index += 1;
            return (
              <PendingRow
                key={item.key}
                item={item}
                href={hrefs[index]}
                index={index}
                cursor={index === cursor}
                now={now}
              />
            );
          })}
        </div>
      ))}
      {archive.length > 0 && <Archive archive={archive} runs={runs} now={now} />}
    </div>
  );
}

import { ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { useListCursor } from '../app/keys';
import { navigate, type Route, routeHref } from '../app/route';
import { type ArchiveItem, buildInboxArchive, groupInboxByDay, type InboxItem } from '../lib/inbox';
import { formatClock } from '../lib/time';
import { useNow } from '../lib/useNow';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { StatusBar } from '../ui/StatusBar';
import { InboxRow } from './InboxRow';
import { useInbox } from './useInbox';

function itemHref(item: InboxItem): string {
  const runId = item.kind === 'ask' ? (item.run?.task.id ?? null) : item.run.task.id;
  return routeHref({ section: 'inbox', runId, view: 'chat' });
}

const ARCHIVE_LABEL: Record<ArchiveItem['kind'], string> = {
  answered: '已回答',
  failed: '失败已看',
  review: '结果已看',
};

function archiveTaskId(item: ArchiveItem): string | null {
  return item.taskId ?? item.run?.task.id ?? null;
}

function ArchiveRow({ item, selected, now }: { item: ArchiveItem; selected: boolean; now: number }) {
  return (
    <a
      href={routeHref({ section: 'inbox', runId: archiveTaskId(item), view: 'chat' })}
      className="relative block border-b border-line/60 px-4 py-2 pl-5 hover:bg-surface-2/50"
    >
      <StatusBar tone="muted" active={selected} />
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-13 text-ink-muted">
          {formatClock(item.at, now)} · {ARCHIVE_LABEL[item.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-15">{item.title}</span>
      </div>
      {item.help && (
        <p className="line-clamp-2 text-14 text-ink-muted">
          问：{item.help.question} / 答：{item.help.answer}
          {item.answeredBy && ` / 回答人：${item.answeredBy}`}
        </p>
      )}
    </a>
  );
}

function Archive({ archive, runId, now }: { archive: ArchiveItem[]; runId: string | null; now: number }) {
  const [open, setOpen] = useState(true);
  const groups = groupInboxByDay(
    archive.map((item) => ({ item, since: item.at })),
    now,
  ).reverse();

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 px-4 py-2 text-left text-14 text-ink-muted hover:bg-surface-2/50"
      >
        <ChevronRight className={`size-4 shrink-0 ${open ? 'rotate-90' : ''}`} />
        已处理 · {archive.length}
      </button>
      {open &&
        groups.map((group) => (
          <div key={group.label}>
            <div className="px-4 py-1.5 text-12 font-medium text-ink-muted">{group.label}</div>
            {group.items.map(({ item }) => (
              <ArchiveRow key={item.id} item={item} selected={archiveTaskId(item) === runId} now={now} />
            ))}
          </div>
        ))}
    </section>
  );
}

export function InboxList({ route }: { route: Route }) {
  const { loaded, runs, helpHistory } = useCluster();
  const items = useInbox(route);
  const archive = useMemo(() => buildInboxArchive(runs, helpHistory), [runs, helpHistory]);
  const now = useNow();
  const groups = groupInboxByDay(items, now);
  const flatItems = groups.flatMap((g) => g.items);
  const hrefs = flatItems.map(itemHref);
  const { cursor } = useListCursor(hrefs, navigate);

  let flatIndex = -1;

  return (
    <>
      <header className="flex items-center justify-between px-4 pt-4 pb-3">
        <h1 className="text-18 font-medium">{items.length > 0 ? `${items.length} 件需要你` : '收件箱'}</h1>
        <a
          href={routeHref({ section: 'runs', composing: true })}
          aria-label="新运行"
          className="rounded-ui p-1 text-ink-muted hover:bg-surface-2 md:hidden"
        >
          <Plus className="size-5" strokeWidth={1.75} />
        </a>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded && <SkeletonRows rows={3} />}
        {loaded && items.length === 0 && archive.length === 0 && (
          <p className="px-4 py-6 text-15 text-ink-muted">没有需要你的事。</p>
        )}
        {loaded && items.length === 0 && archive.length > 0 && (
          <EmptyState title="没有需要你的事。" hint="有 agent 提问、失败或交付时，这里会出现一条。" />
        )}
        {loaded &&
          groups.map((group) => (
            <div key={group.label}>
              <div className="sticky top-0 z-10 bg-surface/95 px-4 py-1.5 text-12 font-medium text-ink-muted backdrop-blur">
                {group.label}
              </div>
              {group.items.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                return (
                  <InboxRow
                    key={item.key}
                    item={item}
                    index={index}
                    href={hrefs[index]}
                    now={now}
                    selected={
                      item.kind === 'ask' ? item.run?.task.id === route.runId : item.run.task.id === route.runId
                    }
                    cursor={index === cursor}
                  />
                );
              })}
            </div>
          ))}
        {loaded && archive.length > 0 && <Archive archive={archive} runId={route.runId} now={now} />}
      </div>
    </>
  );
}

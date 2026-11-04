import { Plus } from 'lucide-react';
import { useCluster } from '../app/ClusterData';
import { useListCursor } from '../app/keys';
import { type Route, routeHref } from '../app/route';
import { groupInboxByDay, type InboxItem } from '../lib/inbox';
import { useNow } from '../lib/useNow';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { InboxRow } from './InboxRow';
import { useInbox } from './useInbox';

function itemHref(item: InboxItem): string {
  const runId = item.kind === 'ask' ? (item.run?.task.id ?? null) : item.run.task.id;
  return routeHref({ section: 'inbox', runId });
}

export function InboxList({ route }: { route: Route }) {
  const { loaded } = useCluster();
  const items = useInbox(route);
  const now = useNow();
  const groups = groupInboxByDay(items, now);
  const flatItems = groups.flatMap((g) => g.items);
  const hrefs = flatItems.map(itemHref);
  const { cursor } = useListCursor(hrefs);

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
        {loaded && items.length === 0 && (
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
      </div>
    </>
  );
}

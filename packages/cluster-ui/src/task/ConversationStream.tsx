import type { ClusterEventEntry, ClusterTaskDetail } from '@qqbot/api-types';
import { ArrowDown, ChevronsUpDown } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { Button } from '../components/ui/button';
import { buildConversation, type ConversationEntry, foldConversation } from '../lib/conversation';
import { useOutput } from '../lib/outputs';
import { EndCard } from './cards/EndCard';
import { OwnerCard } from './cards/OwnerCard';
import { QuestionCard } from './cards/QuestionCard';
import { ReportCard } from './cards/ReportCard';
import { SpawnCard } from './cards/SpawnCard';
import { SystemLine } from './cards/SystemLine';
import { WorkerCard } from './cards/WorkerCard';
import { useLiveSays } from './useLiveSays';

const AT_BOTTOM_SLACK_PX = 48;

function renderEntry(entry: ConversationEntry, ctx: { rootId: string; ticketId?: string; now: number }): ReactNode {
  switch (entry.kind) {
    case 'owner':
      return <OwnerCard entry={entry} now={ctx.now} />;
    case 'report':
      return <ReportCard entry={entry} now={ctx.now} />;
    case 'question':
      return <QuestionCard entry={entry} now={ctx.now} />;
    case 'spawn':
      return <SpawnCard entry={entry} rootId={ctx.rootId} now={ctx.now} />;
    case 'end':
      return <EndCard entry={entry} ticketId={ctx.ticketId} now={ctx.now} />;
    case 'worker':
      return <WorkerCard entry={entry} now={ctx.now} />;
    case 'system':
      return <SystemLine entry={entry} now={ctx.now} />;
  }
}

export function ConversationStream({
  task,
  events,
  rootId,
  ticketId,
  now,
}: {
  task: ClusterTaskDetail;
  events: ClusterEventEntry[];
  rootId: string;
  ticketId?: string;
  now: number;
}) {
  const { loaded, help, helpHistory, workerExits } = useCluster();
  const live = useOutput(task.id);
  const output = live || task.output;
  const liveSays = useLiveSays(task.id, events);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  // Until the shared load lands, every pending question would read as already answered.
  const items = useMemo(
    () =>
      loaded
        ? foldConversation(
            buildConversation({
              task,
              events,
              liveSays,
              help,
              helpHistory,
              workerExitedAt: task.workerId ? workerExits.get(task.workerId) : undefined,
              children: task.children ?? [],
              output,
            }),
          )
        : [],
    [loaded, task, events, liveSays, help, helpHistory, workerExits, output],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new card is what moves the view
  useLayoutEffect(() => {
    const el = scroller.current;
    if (following && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, opened, following]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) {
      setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX);
    }
  };

  const ctx = { rootId, ticketId, now };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-4 md:px-6">
        {!loaded && <p className="text-sm text-muted-foreground">正在读取对话…</p>}
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {items.map((item) => {
            if (!item.fold) {
              return <div key={item.entry.id}>{renderEntry(item.entry, ctx)}</div>;
            }
            if (!opened.has(item.id)) {
              return (
                <Button
                  key={item.id}
                  variant="ghost"
                  size="sm"
                  className="self-center text-muted-foreground"
                  onClick={() => setOpened((prev) => new Set(prev).add(item.id))}
                >
                  <ChevronsUpDown />
                  展开 {item.entries.length} 条
                </Button>
              );
            }
            return item.entries.map((entry) => <div key={entry.id}>{renderEntry(entry, ctx)}</div>);
          })}
        </div>
      </div>
      {!following && (
        <Button
          size="sm"
          className="absolute right-4 bottom-3 shadow-md"
          onClick={() => {
            setFollowing(true);
          }}
        >
          <ArrowDown />
          回到最新
        </Button>
      )}
    </div>
  );
}

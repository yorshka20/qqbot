import { ChevronRight, ChevronsDown, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { StatusDot } from '../components/StatusDot';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '../components/ui/sidebar';
import { modelShortName } from '../lib/model';
import { parseAppLocation, taskPath, workerPath } from '../lib/routes';
import type { Run } from '../lib/runs';
import { STAGE_TONE } from '../lib/stage';
import { buildTaskList, latestSince, type TaskListItem } from '../lib/taskList';
import { formatAgo, formatSpan } from '../lib/time';
import { useNow } from '../lib/useNow';
import { cn } from '../lib/utils';
import type { RunWindow } from '../lib/window';
import { useCluster } from './ClusterData';
import { useListCursor } from './keys';

function runClock(run: Run, now: number): string {
  switch (run.stage) {
    case 'running':
    case 'asking':
    case 'queued':
      return formatSpan(now - run.since);
    default:
      return formatAgo(now - run.since);
  }
}

function RunDot({ run }: { run: Run }) {
  return <StatusDot tone={STAGE_TONE[run.stage]} breathing={run.stage === 'running'} />;
}

function AttentionMark({ attention }: { attention: TaskListItem['attention'] }) {
  if (attention === 'asking') {
    return <MessageCircleQuestion aria-label="等你回答" className="size-4 shrink-0 text-attention" />;
  }
  if (attention === 'failed') {
    return <TriangleAlert aria-label="有失败" className="size-4 shrink-0 text-failed" />;
  }
  return null;
}

interface ItemProps {
  item: TaskListItem;
  row: number;
  now: number;
  cursor: number | null;
  activeTaskId: string | null;
  activeWorkerId: string | null;
}

function TaskItem({ item, row, now, cursor, activeTaskId, activeWorkerId }: ItemProps) {
  const { root, children } = item;
  const selected = activeTaskId === root.task.id;
  const [open, setOpen] = useState(selected || children.some((child) => child.stage === 'asking'));
  const latest = Math.max(root.since, latestSince(item));

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <SidebarMenuItem data-row={row}>
        <SidebarMenuButton
          asChild
          isActive={selected && activeWorkerId === null}
          className={cn('h-auto items-start gap-2 py-1.5 pr-8', cursor === row && 'ring-1 ring-ring')}
        >
          <Link to={taskPath(root.task.id)}>
            <span className="mt-1.5">
              <RunDot run={root} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate">{root.title}</span>
                <AttentionMark attention={item.attention} />
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {modelShortName(root.task.model)} · {runClock(root, now)}
                {children.length > 0 && ` · ${children.length} 个子运行`}
                {root.stage !== 'running' && latest > root.since && ` · 子运行 ${formatAgo(now - latest)}`}
              </span>
            </span>
          </Link>
        </SidebarMenuButton>
        {children.length > 0 && (
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={open ? '收起子运行' : '展开子运行'}
              className="absolute top-1.5 right-1"
            >
              <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
            </Button>
          </CollapsibleTrigger>
        )}
        <CollapsibleContent>
          <SidebarMenuSub>
            {children.map((child) => (
              <SidebarMenuSubItem key={child.task.id}>
                <SidebarMenuSubButton
                  asChild
                  isActive={selected && activeWorkerId === child.task.id}
                  className="h-auto items-start gap-2 py-1"
                >
                  <Link to={workerPath(root.task.id, child.task.id)}>
                    <span className="mt-1.5">
                      <RunDot run={child} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{child.worker?.lastReportSummary || child.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {modelShortName(child.task.model)} · {runClock(child, now)}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** The conversation list: the sidebar's body, and the home page on a phone. */
export function TaskListPanel({ keys = true }: { keys?: boolean }) {
  const { runs, loaded, hasMoreHistory, loadMoreHistory } = useCluster();
  const now = useNow();
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [historyWindow, setHistoryWindow] = useState<RunWindow>('7d');

  const { active, history } = useMemo(
    () => buildTaskList(runs, { now, query, historyWindow }),
    [runs, now, query, historyWindow],
  );
  const current = parseAppLocation(location.pathname, location.search);
  const activeTaskId = current.page === 'task' ? current.taskId : null;
  const activeWorkerId = current.page === 'task' ? current.workerId : null;

  const hrefs = useMemo(() => [...active, ...history].map((item) => taskPath(item.root.task.id)), [active, history]);
  const { cursor } = useListCursor(keys ? hrefs : [], navigate);

  const groups = [
    { label: '活跃', items: active, offset: 0 },
    { label: '历史', items: history, offset: active.length },
  ];
  const empty = active.length === 0 && history.length === 0;

  return (
    <>
      <div className="px-2 pt-1">
        <SidebarInput
          data-search
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题、模型"
          aria-label="搜索对话"
        />
      </div>
      {!loaded && (
        <SidebarGroup>
          <SidebarMenu>
            {[0, 1, 2, 3].map((index) => (
              <SidebarMenuItem key={index}>
                <SidebarMenuSkeleton />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}
      {loaded && empty && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {query.trim() ? '没有匹配的对话。' : '还没有对话，点「新任务」开始。'}
        </p>
      )}
      {loaded &&
        groups.map(
          (group) =>
            group.items.length > 0 && (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item, index) => (
                      <TaskItem
                        key={item.root.task.id}
                        item={item}
                        row={group.offset + index}
                        now={now}
                        cursor={keys ? cursor : null}
                        activeTaskId={activeTaskId}
                        activeWorkerId={activeWorkerId}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ),
        )}
      {loaded && hasMoreHistory && (
        <div className="px-2 pb-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              setHistoryWindow('all');
              loadMoreHistory();
            }}
          >
            <ChevronsDown />
            加载更早
          </Button>
        </div>
      )}
    </>
  );
}

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
import { runModelName } from '../lib/model';
import { parseAppLocation, taskPath, workerPath } from '../lib/routes';
import type { Run } from '../lib/runs';
import { STAGE_TONE } from '../lib/stage';
import { buildTaskList, groupByProject, latestSince, type TaskListItem } from '../lib/taskList';
import { formatAgo, formatSpan } from '../lib/time';
import { useNow } from '../lib/useNow';
import { cn } from '../lib/utils';
import { useCluster } from './ClusterData';
import { useListCursor } from './keys';
import { usePinned } from './pins';

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
  row: number | null;
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
      <SidebarMenuItem data-row={row ?? undefined}>
        <SidebarMenuButton
          asChild
          isActive={selected && activeWorkerId === null}
          className={cn('h-auto items-start gap-2 py-1.5 pr-8', row !== null && cursor === row && 'ring-1 ring-ring')}
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
                {runModelName(root.task)} · {runClock(root, now)}
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
                        {runModelName(child.task)} · {runClock(child, now)}
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
  const [foldedProjects, setFoldedProjects] = useState<ReadonlySet<string>>(new Set());
  const [olderOpen, setOlderOpen] = useState<ReadonlySet<string>>(new Set());

  const pinnedIds = usePinned();
  const list = useMemo(() => buildTaskList(runs, { now, query, pinned: pinnedIds }), [runs, now, query, pinnedIds]);
  const projects = useMemo(() => groupByProject(list), [list]);
  // A search opens every group: a match must not stay folded away.
  const searching = query.trim() !== '';
  const projectOpen = (project: string) => searching || !foldedProjects.has(project);
  const showOlder = (project: string) => searching || olderOpen.has(project);
  const current = parseAppLocation(location.pathname, location.search);
  const activeTaskId = current.page === 'task' ? current.taskId : null;
  const activeWorkerId = current.page === 'task' ? current.workerId : null;

  /** Every visible item in screen order: what `j` / `k` walk and what each row's index counts in. */
  let nextRow = list.pinned.length;
  const sections = projects.map((group) => {
    const open = projectOpen(group.project);
    const recent = open ? [...group.active, ...group.history] : [];
    const older = open && showOlder(group.project) ? group.older : [];
    const section = { group, open, recent, older, offset: nextRow };
    nextRow += recent.length + older.length;
    return section;
  });
  const hrefs = [...list.pinned, ...sections.flatMap((section) => [...section.recent, ...section.older])].map((item) =>
    taskPath(item.root.task.id),
  );
  const { cursor } = useListCursor(keys ? hrefs : [], navigate);

  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(key)) {
      next.add(key);
    }
    return next;
  };
  const items = (entries: TaskListItem[], offset: number) =>
    entries.map((item, index) => (
      <TaskItem
        key={item.root.task.id}
        item={item}
        row={keys ? offset + index : null}
        now={now}
        cursor={keys ? cursor : null}
        activeTaskId={activeTaskId}
        activeWorkerId={activeWorkerId}
      />
    ));
  const empty = list.pinned.length === 0 && projects.length === 0;

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
      {loaded && list.pinned.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>已钉住</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{items(list.pinned, 0)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
      {loaded &&
        sections.map(({ group, open, recent, older, offset }) => (
          <Collapsible
            key={group.project}
            open={open}
            onOpenChange={() => setFoldedProjects((set) => toggle(set, group.project))}
          >
            <SidebarGroup>
              <SidebarGroupLabel asChild>
                <CollapsibleTrigger className="w-full">
                  <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
                  <span className="min-w-0 truncate">{group.project}</span>
                  <span className="ml-auto tabular-nums">
                    {group.active.length + group.history.length + group.older.length}
                  </span>
                </CollapsibleTrigger>
              </SidebarGroupLabel>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>{items(recent, offset)}</SidebarMenu>
                  {group.older.length > 0 && (
                    <Collapsible
                      open={showOlder(group.project)}
                      onOpenChange={() => setOlderOpen((set) => toggle(set, group.project))}
                    >
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="xs" className="w-full justify-start text-muted-foreground">
                          <ChevronRight
                            className={cn('transition-transform', showOlder(group.project) && 'rotate-90')}
                          />
                          更早
                          <span className="ml-auto tabular-nums">{group.older.length}</span>
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenu>{items(older, offset + recent.length)}</SidebarMenu>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        ))}
      {loaded && hasMoreHistory && (
        <div className="px-2 pb-2">
          <Button variant="ghost" size="sm" className="w-full" onClick={loadMoreHistory}>
            <ChevronsDown />
            加载更早
          </Button>
        </div>
      )}
    </>
  );
}

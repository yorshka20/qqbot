import type { ClusterTaskDetail } from '@qqbot/api-types';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  PanelRight,
  PanelRightClose,
  Pin,
  PinOff,
  RotateCcw,
  Square,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { acknowledgeClusterTask, killClusterTask, landClusterJob } from '../api';
import { useCluster } from '../app/ClusterData';
import { togglePinned, usePinned } from '../app/pins';
import { StageBadge } from '../components/StageBadge';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../components/ui/resizable';
import { ScrollArea } from '../components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { retryRun } from '../composer/submitRun';
import { useIsMobile } from '../hooks/use-mobile';
import { deliveryOf } from '../lib/delivery';
import { readDetailOpen, rememberDetailOpen } from '../lib/memory';
import { modelDisplayName } from '../lib/model';
import { useOutput } from '../lib/outputs';
import { PLANNING_STATE_LABEL, planningState } from '../lib/planning';
import { homePath, parseOverlay, parseView, TASK_TABS, type TaskTab, taskPath, withOverlay } from '../lib/routes';
import { type Run, resolveTemplate, runTimes, runTitle } from '../lib/runs';
import { isLive, stageOfStatus } from '../lib/stage';
import { pathOfRun } from '../lib/taskList';
import { formatClock, formatSpan } from '../lib/time';
import { useNow } from '../lib/useNow';
import { RunFlow } from '../topology/RunFlow';
import { TopologyTab } from '../topology/TopologyTab';
import { ConversationStream } from './ConversationStream';
import { DeliveryLine } from './DeliveryLine';
import { DetailPanel } from './DetailPanel';
import { LogView } from './LogView';
import { MessageComposer } from './MessageComposer';
import { ResultTab } from './ResultTab';
import { useTaskDetail } from './useTaskDetail';

const TAB_LABEL: Record<TaskTab, string> = { chat: '对话', topology: '拓扑', result: '结果' };

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">找不到这条运行。它可能已被清理，或调度已停止。</p>
      <Button variant="outline" asChild>
        <Link to={homePath()}>
          <ArrowLeft />
          返回首页
        </Link>
      </Button>
    </div>
  );
}

function KillDialog({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="destructive" disabled={busy} onClick={() => setOpen(true)}>
        <Square />
        终止
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>终止这条运行？</DialogTitle>
            <DialogDescription>worker 会被停掉，没有写完的改动不会保留。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <Square />
              确认终止
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}

function TaskView({ taskId, workerId }: { taskId: string; workerId: string | null }) {
  const currentId = workerId ?? taskId;
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const now = useNow();
  const { runs, loaded, templates, workerExits, refresh, reloadJob } = useCluster();
  const { task: detail, events, failed: loadFailed } = useTaskDetail(currentId);
  const liveOutput = useOutput(currentId);
  const pinned = usePinned().has(taskId);
  const [detailOpen, setDetailOpen] = useState(readDetailOpen);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run: Run | undefined = runs.find((candidate) => candidate.task.id === currentId);
  const task: ClusterTaskDetail | null = detail ?? (run ? run.task : null);
  const overlay = parseOverlay(location.search);

  const urlTab = new URLSearchParams(location.search).get('tab');
  const tab: TaskTab = TASK_TABS.find((candidate) => candidate === urlTab) ?? 'chat';

  const act = async (action: () => Promise<void>) => {
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

  const acknowledged = useRef(new Set<string>());
  const needsAck = run?.stage === 'review';
  // biome-ignore lint/correctness/useExhaustiveDependencies: the run id and stage are the trigger
  useEffect(() => {
    if (needsAck && !acknowledged.current.has(currentId)) {
      acknowledged.current.add(currentId);
      acknowledgeClusterTask(currentId).then(refresh, () => {});
    }
  }, [needsAck, currentId]);

  if (!task) {
    if (loadFailed || loaded) {
      return <NotFound />;
    }
    return <p className="p-6 text-sm text-muted-foreground">正在读取这条运行…</p>;
  }

  const template = resolveTemplate({ project: task.project, template: task.workerTemplate }, templates);
  const isPlanner = templates?.templates.find((t) => t.name === template)?.role === 'planner';
  const planning = planningState(task, {
    isPlanner,
    asks: run?.asks.length ?? 0,
    children: runs.filter((candidate) => candidate.task.parentTaskId === task.id).length,
  });

  const live = isLive(task);
  const stage = run?.stage ?? stageOfStatus(task.status);
  const title = run?.title ?? runTitle(task.description);
  const exitedAt = task.workerId ? workerExits.get(task.workerId) : undefined;
  const { startedAt, endedAt, durationMs } = runTimes(task, exitedAt, now);
  const parentRun = task.parentTaskId ? runs.find((candidate) => candidate.task.id === task.parentTaskId) : undefined;
  const rootRun = runs.find((candidate) => candidate.task.id === taskId);
  const ticketId = run?.ticketId;
  const output = liveOutput || task.output || '';
  const delivery = deliveryOf(run?.job, task);

  const chooseTab = (next: TaskTab) => {
    const params = new URLSearchParams(location.search);
    params.set('tab', next);
    navigate({ pathname: location.pathname, search: `?${params.toString()}` });
  };

  const toggleDetail = () => {
    if (isMobile) {
      setSheetOpen((open) => !open);
      return;
    }
    const next = !detailOpen;
    setDetailOpen(next);
    rememberDetailOpen(next);
  };

  const setLogOverlay = (open: boolean) =>
    navigate({ pathname: location.pathname, search: withOverlay(location.search, { log: open }) });

  const retry = () =>
    act(async () => {
      if (!run) {
        throw new Error('这条运行还没载入，稍后再试。');
      }
      const { task: next } = await retryRun(run, templates);
      await refresh();
      navigate(taskPath(next.id));
    });
  const land = () =>
    act(async () => {
      if (!run?.job) {
        throw new Error('这条运行还没载入，稍后再试。');
      }
      const { error: refused } = await landClusterJob(run.job.id);
      await reloadJob(run.job.id);
      if (refused) {
        throw new Error(refused);
      }
    });
  const kill = () =>
    act(async () => {
      await killClusterTask(task.id, 'Stopped from the console');
      await refresh();
    });
  const acknowledge = () =>
    act(async () => {
      await acknowledgeClusterTask(task.id);
      await refresh();
    });

  const detailPanel = <DetailPanel task={task} live={live} onOpenLog={() => setLogOverlay(true)} />;
  const DetailIcon = detailOpen && !isMobile ? PanelRightClose : PanelRight;

  const main = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="shrink-0 border-b px-3 py-3 md:px-6">
        {workerId !== null && (
          <nav className="mb-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
            <Link to={taskPath(taskId)} className="min-w-0 truncate hover:text-foreground hover:underline">
              {rootRun?.title ?? 'task'}
            </Link>
            <ChevronRight className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{title}</span>
          </nav>
        )}
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 text-lg font-semibold break-words">{title}</h1>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleDetail}
                aria-label={detailOpen && !isMobile ? '关闭详情' : '打开详情'}
              >
                <DetailIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{detailOpen && !isMobile ? '关闭详情' : '打开详情'}</TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <StageBadge stage={stage} />
          {live && planning && <Badge variant="outline">{PLANNING_STATE_LABEL[planning]}</Badge>}
          {task.model && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{modelDisplayName(task.model)}</span>
              </TooltipTrigger>
              <TooltipContent className="font-mono">{task.model}</TooltipContent>
            </Tooltip>
          )}
          <Fact label="开始">{startedAt !== null ? formatClock(startedAt, now) : '尚未开始'}</Fact>
          <Fact label={live ? '已跑' : '用时'}>{durationMs !== null ? formatSpan(durationMs) : '—'}</Fact>
          {endedAt !== null && <Fact label="结束">{formatClock(endedAt, now)}</Fact>}
          {task.parentTaskId && (
            <Link
              to={parentRun ? pathOfRun(parentRun, runs) : taskPath(taskId)}
              className="underline underline-offset-2"
            >
              父运行 {parentRun?.title ?? task.parentTaskId}
            </Link>
          )}
          {overlay.created && !ticketId && (
            <Link
              to={{
                pathname: location.pathname,
                search: withOverlay(location.search, { ticket: { id: overlay.created } }),
              }}
              className="font-mono text-xs underline underline-offset-2"
            >
              已建 ticket {overlay.created}
            </Link>
          )}
          {ticketId && (
            <Link
              to={{ pathname: location.pathname, search: withOverlay(location.search, { ticket: { id: ticketId } }) }}
              className="font-mono text-xs underline underline-offset-2"
            >
              ticket {ticketId}
            </Link>
          )}
        </div>
        {delivery && <DeliveryLine delivery={delivery} busy={busy} onLand={land} />}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!live && (
            <Button disabled={busy || !run} onClick={retry}>
              <RotateCcw />
              重试
            </Button>
          )}
          {live && <KillDialog busy={busy} onConfirm={kill} />}
          {workerId === null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" onClick={() => togglePinned(taskId)} aria-pressed={pinned}>
                  {pinned ? <PinOff /> : <Pin />}
                  {pinned ? '取消钉住' : '钉住'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{pinned ? '从对话列表顶部取消钉住' : '钉在对话列表顶部'}</TooltipContent>
            </Tooltip>
          )}
          {(stage === 'failed' || stage === 'blocked') && (
            <Button variant="outline" disabled={busy} onClick={acknowledge}>
              <Check />
              标记已看
            </Button>
          )}
        </div>
        {error && <p className="mt-1 text-xs break-words text-failed">{error}</p>}
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => chooseTab(value as TaskTab)}
        className="shrink-0 border-b px-3 py-1 md:px-6"
      >
        <TabsList variant="line" className="w-full md:w-auto">
          {TASK_TABS.map((value) => (
            <TabsTrigger key={value} value={value} className="flex-1 md:flex-none">
              {TAB_LABEL[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'chat' && (
        <>
          <ConversationStream task={task} events={events} rootId={taskId} ticketId={ticketId} now={now} />
          <MessageComposer task={task} discussing={planning === 'discussing'} />
        </>
      )}
      {tab === 'topology' && (
        <div className="min-h-0 flex-1">
          {workerId !== null || parseView(location.search) === 'run' ? (
            <RunFlow taskId={currentId} backTo={taskPath(taskId, 'topology')} />
          ) : (
            <TopologyTab rootId={taskId} currentId={currentId} detail={task} />
          )}
        </div>
      )}
      {tab === 'result' && (
        <ScrollArea className="min-h-0 flex-1">
          <ResultTab task={task} rootId={taskId} ticketId={ticketId} output={output} live={live} />
        </ScrollArea>
      )}
    </div>
  );

  return (
    <div className="h-full min-h-0">
      {isMobile || !detailOpen ? (
        main
      ) : (
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel id="task-main" minSize="40%">
            {main}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="task-detail" defaultSize="32%" minSize="20%" maxSize="50%">
            {detailPanel}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {isMobile && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="w-full sm:max-w-md">
            <SheetHeader>
              <SheetTitle>详情</SheetTitle>
              <SheetDescription>任务描述、会话和日志。</SheetDescription>
            </SheetHeader>
            {detailPanel}
          </SheetContent>
        </Sheet>
      )}
      <Dialog open={overlay.log} onOpenChange={(open) => setLogOverlay(open)}>
        <DialogContent className="flex h-dvh max-h-dvh w-screen max-w-none flex-col rounded-none sm:max-w-none">
          <DialogHeader>
            <DialogTitle>日志</DialogTitle>
            <DialogDescription>{title}</DialogDescription>
          </DialogHeader>
          <LogView taskId={task.id} live={live} logPath={task.logPath} className="min-h-0 flex-1" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function TaskPage() {
  const { taskId, workerId } = useParams();
  if (!taskId) {
    return <NotFound />;
  }
  return <TaskView key={workerId ?? taskId} taskId={taskId} workerId={workerId ?? null} />;
}

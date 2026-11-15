import type { ClusterTask, ClusterTaskAction } from '@qqbot/api-types';
import { GitFork, RotateCcw, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { deleteClusterTask, forkClusterTask, retryClusterTask } from '../api';
import { useCluster } from '../app/ClusterData';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { useAction } from '../hooks/use-action';
import { homePath, taskPath } from '../lib/routes';

/** A disabled button says why in its tooltip; the span is there because a disabled button gets no pointer events. */
function Explained({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (reason === null) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

const refusedBy = (action: ClusterTaskAction | undefined): string | null =>
  action === undefined ? '正在读取这条运行…' : action.ok ? null : action.reason;

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="w-full text-xs break-words text-failed">{error}</p> : null;
}

/** The same task again, in its own session: nothing is copied. */
export function RetryButton({ task }: { task: ClusterTask }) {
  const { refresh } = useCluster();
  const { busy, error, run } = useAction();
  const refused = refusedBy(task.retry);
  return (
    <>
      <Explained reason={refused}>
        <Button
          disabled={busy || refused !== null}
          onClick={() =>
            run(async () => {
              await retryClusterTask(task.id);
              await refresh();
            })
          }
        >
          <RotateCcw />
          重试
        </Button>
      </Explained>
      <ErrorLine error={error} />
    </>
  );
}

/** A new conversation that starts from a copy of this one's session, so the model's prompt cache carries over. */
export function ForkButton({ task }: { task: ClusterTask }) {
  const { refresh } = useCluster();
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const refused = refusedBy(task.fork);
  const submit = () =>
    run(async () => {
      const fork = await forkClusterTask(task.id, text.trim());
      setOpen(false);
      setText('');
      await refresh();
      navigate(taskPath(fork.id));
    });
  return (
    <>
      <Explained reason={refused}>
        <Button variant="outline" disabled={busy || refused !== null} onClick={() => setOpen(true)}>
          <GitFork />
          Fork
        </Button>
      </Explained>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从这里 fork 一条新对话</DialogTitle>
            <DialogDescription>
              新对话带着这条运行此刻的全部上下文，在同一个工作区、从它留下的代码继续；原对话不受影响。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="新对话接下来做什么；留空就从原对话停下的地方接着做"
            aria-label="fork 后的指示"
          />
          <ErrorLine error={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              <GitFork />
              开始 fork
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A root task with everything it spawned; refused while any of it still runs. */
export function DeleteButton({ task, refused }: { task: ClusterTask; refused: string | null }) {
  const { refresh } = useCluster();
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Explained reason={refused}>
        <Button variant="ghost" disabled={busy || refused !== null} onClick={() => setOpen(true)}>
          <Trash2 />
          删除
        </Button>
      </Explained>
      <ErrorLine error={error} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这条对话？</DialogTitle>
            <DialogDescription>
              对话、它派生的子运行、提问和日志都会删掉，不能恢复。git 分支留在仓库里，已合入的改动不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await deleteClusterTask(task.id);
                  setOpen(false);
                  navigate(homePath());
                  await refresh();
                })
              }
            >
              <Trash2 />
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

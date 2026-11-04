import { ChevronDown, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { OUTPUT_TAIL_CHARS, useOutput } from '../lib/outputs';
import { Button } from '../ui/Button';

const AT_BOTTOM_SLACK_PX = 24;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function lastLine(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

export function LogPane({ taskId, live, logPath }: { taskId: string; live: boolean; logPath?: string }) {
  const raw = useOutput(taskId);
  const output = raw.replace(ANSI, '');
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const panel = useRef<HTMLPreElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new output is what moves the view
  useLayoutEffect(() => {
    if (open && following && panel.current) {
      panel.current.scrollTop = panel.current.scrollHeight;
    }
  }, [open, following, output]);

  const onScroll = () => {
    const el = panel.current;
    if (el) {
      setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX);
    }
  };

  const Chevron = open ? ChevronDown : ChevronRight;
  const empty = output.length === 0;

  return (
    <section className="mb-6 rounded-ui bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left text-13"
      >
        <Chevron className="size-4 shrink-0 text-ink-muted" />
        <span className="font-medium">日志</span>
        {live && !empty && <span className="text-ink-muted">{open && !following ? '已停止跟随' : '跟随中'}</span>}
        {!open && !empty && <span className="ml-2 min-w-0 truncate font-mono text-ink-muted">{lastLine(output)}</span>}
      </button>
      {open && (
        <div className="relative">
          {empty ? (
            <p className="px-3 pb-3 text-13 text-ink-muted">
              {live ? '还没有输出。' : '输出已不在内存里。'}
              {!live && logPath && <span className="font-mono break-all"> 完整日志在 {logPath}</span>}
            </p>
          ) : (
            <pre
              ref={panel}
              onScroll={onScroll}
              className="max-h-[50vh] overflow-y-auto px-3 pb-3 font-mono text-13 whitespace-pre-wrap break-words"
            >
              {raw.length >= OUTPUT_TAIL_CHARS && <span className="text-ink-muted">只显示最后 256 KB。{'\n'}</span>}
              {output}
            </pre>
          )}
          {!following && (
            <Button variant="solid" className="absolute right-3 bottom-3" onClick={() => setFollowing(true)}>
              回到最新
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

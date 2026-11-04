import { ArrowDown, ChevronDown, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { logLines } from '../lib/logs';
import { OUTPUT_TAIL_CHARS, useOutput } from '../lib/outputs';
import { Button } from '../ui/Button';
import { StatePill } from '../ui/StatePill';

const AT_BOTTOM_SLACK_PX = 24;

export function LogPane({ taskId, live, logPath }: { taskId: string; live: boolean; logPath?: string }) {
  const raw = useOutput(taskId);
  const lines = logLines(raw);
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const [full, setFull] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new output is what moves the view
  useLayoutEffect(() => {
    if (open && following && panel.current) {
      panel.current.scrollTop = panel.current.scrollHeight;
    }
  }, [open, following, lines]);

  useEffect(() => {
    if (!full) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFull(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const onScroll = () => {
    const el = panel.current;
    if (el) {
      setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX);
    }
  };

  const toggleFull = () => {
    if (!full) {
      setOpen(true);
    }
    setFull(!full);
  };

  const Chevron = open ? ChevronDown : ChevronRight;
  const empty = lines.length === 0;
  const lastLine = lines.at(-1) ?? '';

  const sectionClass = full
    ? 'fixed inset-0 z-50 flex flex-col overflow-hidden rounded-none bg-log-bg text-log-ink'
    : 'mb-8 overflow-hidden rounded-ui bg-log-bg text-log-ink';
  const bodyClass = full ? 'relative min-h-0 flex-1' : 'relative';
  const scrollClass = full
    ? 'h-full overflow-y-auto px-3 py-3 pb-[env(safe-area-inset-bottom)]'
    : 'max-h-[50vh] overflow-y-auto px-3 py-3';

  return (
    <section className={sectionClass}>
      <div className="flex min-w-0 items-center gap-1.5 border-b border-white/10 px-3 py-2 text-14">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Chevron className="size-4 shrink-0 opacity-70" />
          <span className="font-medium">日志</span>
          {live && !empty && (
            <StatePill tone={following ? 'working' : 'muted'} label={following ? '跟随中' : '已停止跟随'} />
          )}
          {!open && !empty && <span className="ml-1 min-w-0 truncate font-mono text-13 opacity-70">{lastLine}</span>}
        </button>
        <button
          type="button"
          onClick={toggleFull}
          title={full ? '退出全屏' : '全屏'}
          className="shrink-0 rounded-ui p-1 opacity-70 hover:bg-white/10 hover:opacity-100"
        >
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </div>
      {open && (
        <div className={bodyClass}>
          {empty ? (
            <p className="px-3 py-3 text-13 opacity-70">
              {live ? '还没有输出。' : '输出已不在内存里。'}
              {!live && logPath && <span className="font-mono break-all"> 完整日志在 {logPath}</span>}
            </p>
          ) : (
            <div ref={panel} onScroll={onScroll} className={scrollClass}>
              {raw.length >= OUTPUT_TAIL_CHARS && <p className="mb-1 text-13 opacity-60">只显示最后 256 KB。</p>}
              {/* The output stream is one appended string with no per-line timestamp, so the gutter counts lines. */}
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
                {lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the line number is this row's identity, not an arbitrary index
                  <Fragment key={index}>
                    <span className="select-none text-right font-mono text-13 opacity-40">{index + 1}</span>
                    <span className="font-mono text-13 whitespace-pre-wrap break-words">{line}</span>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
          {!following && (
            <Button variant="solid" className="absolute right-3 bottom-3 gap-1" onClick={() => setFollowing(true)}>
              <ArrowDown className="size-3.5" />
              回到最新
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

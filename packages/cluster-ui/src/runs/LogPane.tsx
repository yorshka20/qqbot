import { AlertTriangle, ArrowDown, ChevronDown, ChevronRight, Maximize2, Minimize2, Wrench } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { logLines } from '../lib/logs';
import { OUTPUT_TAIL_CHARS, useOutput } from '../lib/outputs';
import { formatClock } from '../lib/time';
import { parseTranscript, type TranscriptEntry } from '../lib/transcript';
import { Button } from '../ui/Button';
import { StatePill } from '../ui/StatePill';

const AT_BOTTOM_SLACK_PX = 24;

function TranscriptRow({
  entry,
  now,
  showClock,
  expanded,
  onToggle,
}: {
  entry: TranscriptEntry;
  now: number;
  showClock: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { kind, title, body, failed } = entry;
  const foldable = (kind === 'tool' || kind === 'reasoning') && body !== undefined;

  let content: ReactNode;
  if (kind === 'text') {
    content = <p className="text-15 whitespace-pre-wrap break-words">{body}</p>;
  } else if (kind === 'result') {
    content = (
      <>
        <p className="text-13 opacity-60">{title}</p>
        <p className="text-15 whitespace-pre-wrap break-words">{body}</p>
      </>
    );
  } else if (kind === 'raw') {
    content = <p className="font-mono text-13 opacity-60 whitespace-pre-wrap break-words">{body}</p>;
  } else {
    const label =
      kind === 'tool' ? (
        <span
          className={`flex min-w-0 items-center gap-1.5 font-mono text-13 ${failed ? 'text-failed' : 'opacity-80'}`}
        >
          {failed ? (
            <AlertTriangle className="size-3.5 shrink-0" />
          ) : (
            <Wrench className="size-3.5 shrink-0 opacity-70" />
          )}
          <span className="truncate">{title}</span>
        </span>
      ) : (
        <span className={`block text-13 opacity-50 ${expanded ? '' : 'line-clamp-2'}`}>{title}</span>
      );
    content = (
      <>
        {foldable ? (
          <button
            type="button"
            onClick={() => onToggle(entry.id)}
            aria-expanded={expanded}
            className="block w-full min-w-0 text-left"
          >
            {label}
          </button>
        ) : (
          label
        )}
        {foldable && expanded && (
          <pre className="mt-1 max-h-64 overflow-y-auto font-mono text-13 whitespace-pre-wrap break-words opacity-70">
            {body}
          </pre>
        )}
      </>
    );
  }

  return (
    <div className="flex gap-2">
      {showClock && (
        <span className="min-w-[5ch] shrink-0 font-mono text-13 whitespace-nowrap opacity-50">
          {entry.at === undefined ? '' : formatClock(entry.at, now)}
        </span>
      )}
      <div className="min-w-0 flex-1">{content}</div>
    </div>
  );
}

export function LogPane({ taskId, live, logPath }: { taskId: string; live: boolean; logPath?: string }) {
  const raw = useOutput(taskId);
  const lines = logLines(raw);
  const entries = useMemo(() => parseTranscript(raw), [raw]);
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const [full, setFull] = useState(false);
  const [rawView, setRawView] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const panel = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new output is what moves the view
  useLayoutEffect(() => {
    if (open && following && panel.current) {
      panel.current.scrollTop = panel.current.scrollHeight;
    }
  }, [open, following, lines, rawView]);

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

  const toggleEntry = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  };

  const Chevron = open ? ChevronDown : ChevronRight;
  const empty = lines.length === 0;
  const readable = entries !== null && !rawView;
  const preview = readable ? (entries.at(-1)?.title ?? '') : (lines.at(-1) ?? '');
  const showClock = readable && entries.some((entry) => entry.at !== undefined);
  const now = Date.now();

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
          <span className="font-medium">{readable ? 'worker 输出' : '原始输出'}</span>
          {live && !empty && (
            <StatePill tone={following ? 'working' : 'muted'} label={following ? '跟随中' : '已停止跟随'} />
          )}
          {!open && !empty && (
            <span className={`ml-1 min-w-0 truncate text-13 opacity-70 ${readable ? '' : 'font-mono'}`}>{preview}</span>
          )}
        </button>
        {entries !== null && (
          <button
            type="button"
            onClick={() => setRawView(!rawView)}
            className="shrink-0 rounded-ui px-1.5 py-0.5 text-13 opacity-70 hover:bg-white/10 hover:opacity-100"
          >
            {rawView ? '可读' : '原始'}
          </button>
        )}
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
              {readable ? (
                <div className="flex flex-col gap-2">
                  {entries.map((entry) => (
                    <TranscriptRow
                      key={entry.id}
                      entry={entry}
                      now={now}
                      showClock={showClock}
                      expanded={expanded.has(entry.id)}
                      onToggle={toggleEntry}
                    />
                  ))}
                </div>
              ) : (
                // The output stream is one appended string with no per-line timestamp, so the gutter counts lines.
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
                  {lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the line number is this row's identity, not an arbitrary index
                    <Fragment key={index}>
                      <span className="select-none text-right font-mono text-13 opacity-40">{index + 1}</span>
                      <span className="font-mono text-13 whitespace-pre-wrap break-words">{line}</span>
                    </Fragment>
                  ))}
                </div>
              )}
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

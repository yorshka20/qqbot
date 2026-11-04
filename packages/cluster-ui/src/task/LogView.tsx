import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowDown, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { logLines } from '../lib/logs';
import { OUTPUT_TAIL_CHARS, useOutput } from '../lib/outputs';
import { formatClock } from '../lib/time';
import { parseTranscript, type TranscriptEntry } from '../lib/transcript';
import { cn } from '../lib/utils';

const AT_BOTTOM_SLACK_PX = 32;

type Mode = 'readable' | 'raw';

function TranscriptRow({
  entry,
  expanded,
  onToggle,
  now,
  showClock,
}: {
  entry: TranscriptEntry;
  expanded: boolean;
  onToggle: () => void;
  now: number;
  showClock: boolean;
}) {
  const { kind, title, body, failed } = entry;
  const foldable = (kind === 'tool' || kind === 'reasoning') && body !== undefined;

  let content: React.ReactNode;
  if (kind === 'text' || kind === 'result') {
    content = (
      <>
        {kind === 'result' && <p className={cn('text-xs opacity-60', failed && 'text-failed opacity-100')}>{title}</p>}
        <p className="text-sm whitespace-pre-wrap break-words">{body}</p>
      </>
    );
  } else if (kind === 'raw') {
    content = <p className="font-mono text-xs break-words whitespace-pre-wrap opacity-60">{body}</p>;
  } else {
    const label = (
      <span
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-xs',
          kind === 'tool' ? 'font-mono' : 'opacity-60',
          failed && 'text-failed',
        )}
      >
        {kind === 'tool' &&
          (failed ? (
            <AlertTriangle className="size-3.5 shrink-0" />
          ) : (
            <Wrench className="size-3.5 shrink-0 opacity-70" />
          ))}
        <span className={cn(expanded || kind === 'tool' ? 'break-all' : 'line-clamp-2')}>{title}</span>
      </span>
    );
    content = (
      <>
        {foldable ? (
          <button type="button" onClick={onToggle} aria-expanded={expanded} className="block w-full min-w-0 text-left">
            {label}
          </button>
        ) : (
          label
        )}
        {foldable && expanded && (
          <pre className="mt-1 max-h-64 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap opacity-70">
            {body}
          </pre>
        )}
      </>
    );
  }

  return (
    <div className="flex gap-2 px-3 py-1">
      {showClock && (
        <span className="min-w-[5ch] shrink-0 font-mono text-xs whitespace-nowrap opacity-50">
          {entry.at === undefined ? '' : formatClock(entry.at, now)}
        </span>
      )}
      <div className="min-w-0 flex-1">{content}</div>
    </div>
  );
}

export function LogView({
  taskId,
  live,
  logPath,
  className,
}: {
  taskId: string;
  live: boolean;
  logPath?: string;
  className?: string;
}) {
  const raw = useOutput(taskId);
  const lines = useMemo(() => logLines(raw), [raw]);
  const entries = useMemo(() => parseTranscript(raw), [raw]);
  const [mode, setMode] = useState<Mode>('readable');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const readable = entries !== null && mode === 'readable';
  const count = readable ? entries.length : lines.length;
  const showClock = readable && entries.some((entry) => entry.at !== undefined);
  const now = Date.now();

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => 24,
    overscan: 12,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows are what move the view
  useEffect(() => {
    if (following && count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: 'end' });
    }
  }, [count, following, mode, raw]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) {
      setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX);
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });

  if (count === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {live ? '还没有输出。' : '这条运行已结束，daemon 只在内存里保留 stdout，输出读不到了。'}
        {!live && logPath && <span className="font-mono text-xs break-all"> 完整日志在 cluster 主机上：{logPath}</span>}
      </p>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        {entries !== null ? (
          <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
            <TabsList>
              <TabsTrigger value="readable">可读</TabsTrigger>
              <TabsTrigger value="raw">原始</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          <span className="text-xs text-muted-foreground">原始输出</span>
        )}
        {raw.length >= OUTPUT_TAIL_CHARS && <span className="text-xs text-muted-foreground">只显示最后 256 KB</span>}
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="h-full min-h-40 overflow-y-auto rounded-md bg-log-bg py-2 text-log-ink"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = readable ? entries[item.index] : undefined;
              return (
                <div
                  key={entry ? entry.id : item.index}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {entry ? (
                    <TranscriptRow
                      entry={entry}
                      expanded={expanded.has(entry.id)}
                      onToggle={() => toggle(entry.id)}
                      now={now}
                      showClock={showClock}
                    />
                  ) : (
                    <div className="flex gap-3 px-3">
                      <span className="w-10 shrink-0 text-right font-mono text-xs opacity-40 select-none">
                        {item.index + 1}
                      </span>
                      <span className="min-w-0 flex-1 font-mono text-xs break-words whitespace-pre-wrap">
                        {lines[item.index]}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {!following && (
          <Button size="sm" className="absolute right-3 bottom-3 shadow-md" onClick={() => setFollowing(true)}>
            <ArrowDown />
            回到最新
          </Button>
        )}
      </div>
    </div>
  );
}

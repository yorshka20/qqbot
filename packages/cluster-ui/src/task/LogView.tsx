import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getClusterTaskOutput } from '../api';
import { Button } from '../components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { logLines } from '../lib/logs';
import { hasOutput, OUTPUT_TAIL_CHARS, setOutput, useOutput } from '../lib/outputs';
import { parseTranscript } from '../lib/transcript';
import { cn } from '../lib/utils';
import { TranscriptRow } from './TranscriptRow';

const AT_BOTTOM_SLACK_PX = 32;

type Mode = 'readable' | 'raw';

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
  const [reading, setReading] = useState(!live && raw === '');
  useEffect(() => {
    if (live || hasOutput(taskId)) {
      setReading(false);
      return;
    }
    let cancelled = false;
    setReading(true);
    getClusterTaskOutput(taskId)
      .then(({ output }) => {
        if (!cancelled && output) {
          setOutput(taskId, output);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setReading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, live]);
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
        {reading ? '正在读取日志…' : live ? '还没有输出。' : '这条运行没有留下输出。'}
        {!live && !reading && logPath && <span className="font-mono text-xs break-all"> 日志文件：{logPath}</span>}
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

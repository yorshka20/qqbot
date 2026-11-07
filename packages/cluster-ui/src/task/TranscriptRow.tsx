import { AlertTriangle, Wrench } from 'lucide-react';
import { Button } from '../components/ui/button';
import { formatClock } from '../lib/time';
import type { TranscriptEntry } from '../lib/transcript';
import { cn } from '../lib/utils';

export function TranscriptRow({
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
  } else if (kind === 'session') {
    content = (
      <div className="flex items-center gap-2 text-xs opacity-50">
        <span className="h-px flex-1 bg-current" />
        <span className="whitespace-nowrap">{title}</span>
        <span className="h-px flex-1 bg-current" />
      </div>
    );
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
          <Button
            type="button"
            variant="ghost"
            onClick={onToggle}
            aria-expanded={expanded}
            className="h-auto w-full min-w-0 justify-start rounded-none p-0 text-left font-normal text-inherit whitespace-normal hover:bg-log-ink/10 hover:text-inherit dark:hover:bg-log-ink/10"
          >
            {label}
          </Button>
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

import { Markdown } from '../../components/Markdown';
import type { ConversationEntry } from '../../lib/conversation';
import { formatClock } from '../../lib/time';

type Entry = Extract<ConversationEntry, { kind: 'report' }>;

export function ReportCard({ entry, now }: { entry: Entry; now: number }) {
  const { stats } = entry;
  return (
    <div className="rounded-lg border bg-card p-3 text-card-foreground">
      <div className="mb-1 text-xs text-muted-foreground">进展 · {formatClock(entry.at, now)}</div>
      <Markdown>{entry.summary}</Markdown>
      {entry.nextSteps && (
        <div className="mt-2 border-t pt-2 text-muted-foreground">
          <div className="text-xs">下一步</div>
          <Markdown className="text-muted-foreground">{entry.nextSteps}</Markdown>
        </div>
      )}
      {(entry.files.length > 0 || stats) && (
        <div className="mt-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {entry.files.length > 0 && <span>改了 {entry.files.length} 个文件</span>}
          {stats?.linesAdded !== undefined && <span>+{stats.linesAdded}</span>}
          {stats?.linesRemoved !== undefined && <span>-{stats.linesRemoved}</span>}
          {stats?.testsRan !== undefined && (
            <span>
              测试 {stats.testsPassed ?? '?'}/{stats.testsRan}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

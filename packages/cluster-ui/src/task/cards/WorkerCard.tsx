import { Markdown } from '../../components/Markdown';
import type { ConversationEntry } from '../../lib/conversation';
import { formatClock } from '../../lib/time';

type Entry = Extract<ConversationEntry, { kind: 'worker' }>;

export function WorkerCard({ entry, now }: { entry: Entry; now: number }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="max-w-[85%] rounded-lg border bg-card px-3 py-2 text-card-foreground">
        <Markdown>{entry.text}</Markdown>
      </div>
      <span className="text-xs text-muted-foreground">worker · {formatClock(entry.at, now)}</span>
    </div>
  );
}

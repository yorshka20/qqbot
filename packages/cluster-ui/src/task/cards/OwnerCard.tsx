import type { ConversationEntry } from '../../lib/conversation';
import { formatClock } from '../../lib/time';

type Entry = Extract<ConversationEntry, { kind: 'owner' }>;

export function OwnerCard({ entry, now }: { entry: Entry; now: number }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-lg border bg-secondary px-3 py-2 text-sm whitespace-pre-wrap break-words text-secondary-foreground">
        {entry.text}
      </div>
      <span className="text-xs text-muted-foreground">我 · {formatClock(entry.at, now)}</span>
    </div>
  );
}

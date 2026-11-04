import type { ConversationEntry } from '../../lib/conversation';
import { formatClock } from '../../lib/time';

type Entry = Extract<ConversationEntry, { kind: 'system' }>;

export function SystemLine({ entry, now }: { entry: Entry; now: number }) {
  return (
    <p className="text-center text-xs break-words text-muted-foreground">
      {formatClock(entry.at, now)} · {entry.text}
    </p>
  );
}

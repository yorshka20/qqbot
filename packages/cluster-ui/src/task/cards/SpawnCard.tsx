import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import type { ConversationEntry } from '../../lib/conversation';
import { modelShortName } from '../../lib/model';
import { workerPath } from '../../lib/routes';
import { runTitle } from '../../lib/runs';
import { formatClock } from '../../lib/time';

type Entry = Extract<ConversationEntry, { kind: 'spawn' }>;

export function SpawnCard({ entry, rootId, now }: { entry: Entry; rootId: string; now: number }) {
  const facts = [entry.template, entry.model ? modelShortName(entry.model) : undefined].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 text-card-foreground">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">
          派生 · {formatClock(entry.at, now)}
          {facts && ` · ${facts}`}
        </div>
        <p className="truncate text-sm">spawn 了执行器：{runTitle(entry.description)}</p>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link to={workerPath(rootId, entry.childTaskId)}>
          查看
          <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}

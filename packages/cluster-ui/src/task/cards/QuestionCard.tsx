import { ChevronDown } from 'lucide-react';
import { AnswerForm } from '../../components/AnswerForm';
import { Markdown } from '../../components/Markdown';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import type { ConversationEntry } from '../../lib/conversation';
import { runTitle } from '../../lib/runs';
import { formatClock } from '../../lib/time';
import { cn } from '../../lib/utils';

type Entry = Extract<ConversationEntry, { kind: 'question' }>;

export function QuestionCard({ entry, now }: { entry: Entry; now: number }) {
  const body = (
    <>
      <Markdown>{entry.question}</Markdown>
      {entry.context && <Markdown className="mt-1 text-muted-foreground">{entry.context}</Markdown>}
      {entry.pending ? (
        <AnswerForm askId={entry.askId} options={entry.options} className="mt-3" />
      ) : (
        entry.answer !== undefined && (
          <div className="mt-2 border-t pt-2">
            <div className="text-xs text-muted-foreground">
              答 · {entry.answeredBy ?? '未知'}
              {entry.answeredAt !== undefined && ` · ${formatClock(entry.answeredAt, now)}`}
            </div>
            <p className="mt-1 text-sm whitespace-pre-wrap break-words">{entry.answer}</p>
          </div>
        )
      )}
    </>
  );

  if (!entry.pending && entry.answer !== undefined) {
    return (
      <Collapsible className="min-w-0 rounded-lg border bg-card text-card-foreground">
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm">
          <span className="min-w-0 flex-1 truncate">{runTitle(entry.question)}</span>
          <span className="min-w-0 max-w-[40%] truncate text-muted-foreground">{entry.answer}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          <div className="mb-1 text-xs text-muted-foreground">提问 · {formatClock(entry.at, now)}</div>
          {body}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-3 text-card-foreground',
        entry.pending && 'border-attention bg-attention/10',
      )}
    >
      <div className={cn('mb-1 text-xs', entry.pending ? 'text-attention' : 'text-muted-foreground')}>
        {entry.pending ? '等你回答' : '提问'} · {formatClock(entry.at, now)}
      </div>
      {body}
    </div>
  );
}

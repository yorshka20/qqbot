import { AnswerForm } from '../../components/AnswerForm';
import { Markdown } from '../../components/Markdown';
import type { ConversationEntry } from '../../lib/conversation';
import { formatClock } from '../../lib/time';
import { cn } from '../../lib/utils';

type Entry = Extract<ConversationEntry, { kind: 'question' }>;

export function QuestionCard({ entry, now }: { entry: Entry; now: number }) {
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
    </div>
  );
}

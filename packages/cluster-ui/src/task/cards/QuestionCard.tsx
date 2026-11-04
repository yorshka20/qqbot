import { Send } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { answerClusterHelpRequest } from '../../api';
import { useCluster } from '../../app/ClusterData';
import { Markdown } from '../../components/Markdown';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import type { ConversationEntry } from '../../lib/conversation';
import { formatClock } from '../../lib/time';
import { cn } from '../../lib/utils';

type Entry = Extract<ConversationEntry, { kind: 'question' }>;

function AnswerForm({ askId, options }: { askId: string; options?: string[] }) {
  const { refresh } = useCluster();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { answered } = await answerClusterHelpRequest(askId, { answer: trimmed, answeredBy: 'owner' });
      if (!answered) {
        setError('这个问题已经被回答或过期了。');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(text);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button key={option} variant="outline" size="sm" disabled={sending} onClick={() => send(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          data-answer-box
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="在这里回答（⌘Enter 发送）"
          aria-label="回答"
          className="min-h-0 resize-none"
        />
        <Button disabled={sending || !text.trim()} onClick={() => send(text)}>
          <Send />
          发送回答
        </Button>
      </div>
      {error && <p className="text-xs text-failed">{error}</p>}
    </div>
  );
}

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
        <AnswerForm askId={entry.askId} options={entry.options} />
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

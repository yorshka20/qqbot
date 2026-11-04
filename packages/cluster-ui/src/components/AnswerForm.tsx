import { Send } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { answerClusterHelpRequest } from '../api';
import { useCluster } from '../app/ClusterData';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

export function AnswerForm({ askId, options, className }: { askId: string; options?: string[]; className?: string }) {
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
    <div className={cn('flex flex-col gap-2', className)}>
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

import { type KeyboardEvent, useState } from 'react';
import { answerClusterHelpRequest } from '../api';
import { useCluster } from '../app/ClusterData';
import { rememberAnswer } from '../lib/memory';
import { Button } from '../ui/Button';
import { INPUT_CLASS } from '../ui/Field';

export function AnswerBox({
  askId,
  options,
  compact = false,
}: {
  askId: string;
  options?: string[];
  compact?: boolean;
}) {
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
      if (answered) {
        rememberAnswer(askId, trimmed);
      } else {
        setError('这个问题已经被回答或过期了。');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an IME is composing picks a candidate, it must not send.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <Button key={option} disabled={sending} onClick={() => send(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          data-answer-box
          rows={compact ? 1 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="在这里回答"
          aria-label="回答"
          className={`${INPUT_CLASS} resize-none`}
        />
        <Button variant="solid" disabled={sending || !text.trim()} onClick={() => send(text)}>
          发送回答
        </Button>
      </div>
      {error && <p className="text-13 text-failed">{error}</p>}
    </div>
  );
}

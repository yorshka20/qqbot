import type { ClusterTask } from '@qqbot/api-types';
import { type KeyboardEvent, useState } from 'react';
import { sendClusterTaskMessage } from '../api';
import { useCluster } from '../app/ClusterData';
import { messageAvailability } from '../lib/runs';
import { Button } from '../ui/Button';
import { INPUT_CLASS } from '../ui/Field';

export function MessageBox({ task }: { task: ClusterTask }) {
  const { refresh } = useCluster();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { enabled, hint } = messageAvailability(task);

  const send = async () => {
    const trimmed = text.trim();
    if (!enabled || !trimmed || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendClusterTaskMessage(task.id, trimmed);
      setText('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="sticky bottom-0 -mx-5 border-t border-line bg-surface px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:-mx-8 md:px-8">
      <div className="flex items-end gap-1.5">
        <textarea
          rows={2}
          value={text}
          disabled={!enabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="对 worker 说点什么（⌘Enter 发送）"
          aria-label="给 worker 发消息"
          className={`${INPUT_CLASS} min-w-0 resize-none disabled:opacity-50`}
        />
        <Button variant="solid" disabled={!enabled || sending || !text.trim()} onClick={() => void send()}>
          发送
        </Button>
      </div>
      <p className="mt-1 text-13 text-ink-muted">{hint}</p>
      {error && <p className="mt-1 text-13 whitespace-pre-wrap break-words text-failed">{error}</p>}
    </div>
  );
}

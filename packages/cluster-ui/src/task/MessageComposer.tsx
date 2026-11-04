import type { ClusterTask } from '@qqbot/api-types';
import { Send } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { sendClusterTaskMessage } from '../api';
import { useCluster } from '../app/ClusterData';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { MESSAGE_ENABLED_HINT, messageAvailability } from '../lib/runs';

export function MessageComposer({ task, discussing }: { task: ClusterTask; discussing: boolean }) {
  const { refresh } = useCluster();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { enabled, hint } = messageAvailability(task);
  const direct = enabled && task.status === 'running' && !task.resumable;

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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="shrink-0 border-t bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            value={text}
            disabled={!enabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              discussing ? '给 planner 提意见，它会按你说的改方案（⌘Enter 发送）' : '对 worker 说点什么（⌘Enter 发送）'
            }
            aria-label="给 worker 发消息"
            className="max-h-40 min-h-0 min-w-0 resize-none"
          />
          <Button disabled={!enabled || sending || !text.trim()} onClick={() => void send()}>
            <Send />
            发送
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {direct ? `${MESSAGE_ENABLED_HINT}它只收到这条消息的文本，看不到上面的对话。` : hint}
        </p>
        {error && <p className="mt-1 text-xs break-words whitespace-pre-wrap text-failed">{error}</p>}
      </div>
    </div>
  );
}

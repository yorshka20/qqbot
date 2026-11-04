import type { ClusterEventEntry } from '@qqbot/api-types';
import { useRef, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import type { LiveSay } from '../lib/conversation';
import { useClusterStream } from '../stream/useClusterStream';

export function useLiveSays(taskId: string, events: ClusterEventEntry[]): LiveSay[] {
  const { cluster } = useCluster();
  const [says, setSays] = useState<LiveSay[]>([]);
  // Events arrive newest first, so the latest seq is the maximum, not the last item.
  const latestSeq = useRef(0);
  latestSeq.current = events.reduce((max, event) => Math.max(max, event.seq), 0);

  useClusterStream((event, data) => {
    if (event !== 'task_message') {
      return;
    }
    const message = data as { taskId: string; from: string; kind: string; text: string };
    if (message.from !== 'worker' || message.kind !== 'say' || message.taskId !== taskId) {
      return;
    }
    const afterSeq = latestSeq.current;
    setSays((prev) => [...prev, { id: `live:${prev.length}`, at: Date.now(), text: message.text, afterSeq }]);
  }, cluster?.started === true);

  return says;
}

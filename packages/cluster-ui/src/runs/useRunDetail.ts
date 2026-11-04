import type { ClusterEventEntry, ClusterTaskDetail } from '@qqbot/api-types';
import { useEffect, useState } from 'react';
import { getClusterTask, getClusterTaskEvents } from '../api';
import { useCluster } from '../app/ClusterData';

export interface RunDetailData {
  task: ClusterTaskDetail | null;
  events: ClusterEventEntry[];
  failed: boolean;
}

/** Follows the shared refresh, so the timeline moves on the same SSE events as the lists. */
export function useRunDetail(runId: string): RunDetailData {
  const { version } = useCluster();
  const [data, setData] = useState<RunDetailData>({ task: null, events: [], failed: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the re-read trigger
  useEffect(() => {
    let cancelled = false;
    Promise.all([getClusterTask(runId), getClusterTaskEvents(runId)]).then(
      ([task, events]) => {
        if (!cancelled) {
          setData({ task, events, failed: false });
        }
      },
      () => {
        if (!cancelled) {
          setData((prev) => ({ ...prev, failed: true }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, version]);

  return data;
}

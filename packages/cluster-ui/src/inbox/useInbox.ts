import { useMemo } from 'react';
import { useCluster } from '../app/ClusterData';
import type { Route } from '../app/route';
import { buildInbox, type InboxItem } from '../lib/inbox';

export function useInbox(route: Route): InboxItem[] {
  const { runs, help } = useCluster();
  return useMemo(() => buildInbox(runs, help, route.runId), [runs, help, route.runId]);
}

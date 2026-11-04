import { useMemo } from 'react';
import { useCluster } from '../app/ClusterData';
import type { Route } from '../app/route';
import { buildInbox, type InboxItem } from '../lib/inbox';
import { useSeen } from '../lib/memory';

export function useInbox(route: Route): InboxItem[] {
  const { runs, help } = useCluster();
  const seen = useSeen();
  return useMemo(() => buildInbox(runs, help, seen, route.runId), [runs, help, seen, route.runId]);
}

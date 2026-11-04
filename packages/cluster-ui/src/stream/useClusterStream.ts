import { useEffect, useRef } from 'react';
import { type ClusterStreamListener, subscribeClusterStream } from './clusterStream';

const MIN_REFRESH_INTERVAL_MS = 1000;

export function useClusterStream(listener: ClusterStreamListener, enabled = true): void {
  const latest = useRef(listener);
  latest.current = listener;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return subscribeClusterStream((event, data) => latest.current(event, data));
  }, [enabled]);
}

/**
 * Run `refresh` when one of `events` arrives, at most once per second: a busy worker emits
 * `task_output` many times a second and every refresh is several requests.
 */
export function useRefreshOnClusterEvents(events: readonly string[], refresh: () => void, enabled = true): void {
  const timer = useRef<number | null>(null);
  const lastRun = useRef(0);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  useClusterStream((event) => {
    if (!events.includes(event) || timer.current !== null) {
      return;
    }
    const wait = Math.max(0, lastRun.current + MIN_REFRESH_INTERVAL_MS - Date.now());
    timer.current = window.setTimeout(() => {
      timer.current = null;
      lastRun.current = Date.now();
      latestRefresh.current();
    }, wait);
  }, enabled);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );
}

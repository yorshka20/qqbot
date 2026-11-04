import { authorizedFetch } from '../auth/session';
import { SSEParser } from './sse';

const RECONNECT_DELAY_MS = 5000;

export type ClusterStreamListener = (event: string, data: unknown) => void;

const listeners = new Set<ClusterStreamListener>();
let connection: AbortController | null = null;

function dispatch(event: string, raw: string): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  for (const listener of listeners) {
    listener(event, data);
  }
}

async function readEvents(body: ReadableStream<Uint8Array>): Promise<void> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
      dispatch(message.event, message.data);
    }
  }
}

function waitToReconnect(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RECONNECT_DELAY_MS);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function run(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await authorizedFetch('/api/cluster/stream', { signal, headers: { Accept: 'text/event-stream' } });
      if (res.status === 401) {
        return;
      }
      if (res.ok && res.body) {
        await readEvents(res.body);
      }
    } catch {
      // A dropped connection and a daemon that is down both end here; the loop reconnects.
    }
    await waitToReconnect(signal);
  }
}

/**
 * Follow `GET /api/cluster/stream`. `EventSource` cannot send the Authorization header, hence
 * fetch. All subscribers share one connection: a stream pins one of the browser's six HTTP/1.1
 * connections to the host for as long as it is open.
 */
export function subscribeClusterStream(listener: ClusterStreamListener): () => void {
  listeners.add(listener);
  if (!connection) {
    connection = new AbortController();
    void run(connection.signal);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      connection?.abort();
      connection = null;
    }
  };
}

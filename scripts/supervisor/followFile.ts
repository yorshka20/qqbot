// Follow one growing file line by line, the way `tail -f` does, on every platform.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 500;

export interface FollowFileOptions {
  signal: AbortSignal;
  initialLines: number;
}

/**
 * Emit `initialLines` last lines of `path` (when it exists), then every line appended to it until
 * `signal` aborts. A file that is truncated or replaced is read again from its start.
 */
export async function followFile(
  path: string,
  onLine: (line: string) => void,
  { signal, initialLines }: FollowFileOptions,
): Promise<void> {
  let position = 0;
  let pending = '';
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf8');
    position = Buffer.byteLength(content);
    if (initialLines > 0) {
      for (const line of content.split('\n').slice(0, -1).slice(-initialLines)) {
        onLine(line);
      }
    }
  }
  const decoder = new TextDecoder();
  const buffer = Buffer.alloc(64 * 1024);
  while (!signal.aborted) {
    await sleep(POLL_MS, undefined, { signal }).catch(() => {});
    if (!existsSync(path)) {
      continue;
    }
    if (statSync(path).size < position) {
      position = 0;
      pending = '';
    }
    const fd = openSync(path, 'r');
    try {
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, position);
        if (read === 0) {
          break;
        }
        position += read;
        pending += decoder.decode(buffer.subarray(0, read), { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          onLine(line);
        }
      }
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Follows a file that another process appends to, by polling its size. Used for worker
 * stdout: workers are detached processes whose output goes to a file, not a pipe, so the
 * scheduler can stop and start without the worker noticing.
 *
 * Polling rather than `fs.watch`: watch events for appends are unreliable on macOS, and
 * the files are few and small enough that a stat every few hundred milliseconds costs
 * nothing.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

export class LogTail {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = '';

  constructor(
    private readonly path: string,
    private readonly onLine: (line: string) => void,
    private readonly onChunk: (text: string) => void,
    private readonly intervalMs = 300,
  ) {}

  /** Start following from the current end of the file (or from its start when `fromStart`). */
  start(fromStart = false): void {
    if (this.timer) return;
    if (!fromStart && existsSync(this.path)) {
      this.offset = statSync(this.path).size;
    }
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** Read whatever was appended since the last poll, then stop following. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.poll();
    if (this.pending) {
      this.onLine(this.pending);
      this.pending = '';
    }
  }

  private poll(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;
    const length = size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = openSync(this.path, 'r');
    try {
      readSync(fd, buffer, 0, length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const text = buffer.toString('utf8');
    this.onChunk(text);
    this.pending += text;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.onLine(line);
    }
  }
}

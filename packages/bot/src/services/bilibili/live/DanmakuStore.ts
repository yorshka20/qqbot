// DanmakuStore — thin persistence wrapper around the `bilibiliDanmaku`
// model. Queues inserts so the hot WS receive path never awaits a DB write;
// a worker drains the queue in-order and logs failures instead of crashing.

import { inject, injectable, singleton } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { BilibiliDanmakuRecord } from '@/database/models/types';
import { logger } from '@/utils/logger';
import type { DanmakuEvent } from './BilibiliLiveClient';

export interface PersistOptions {
  roomId: string;
  streamerAliases?: string[];
  batchId?: string;
  mentionsStreamer?: boolean;
}

type Pending = Omit<BilibiliDanmakuRecord, 'id' | 'createdAt' | 'updatedAt'>;

@injectable()
@singleton()
export class DanmakuStore {
  private queue: Pending[] = [];
  private draining = false;
  /** Upper bound on the backlog to keep memory bounded if the DB stalls. */
  private readonly MAX_QUEUE = 10_000;

  constructor(@inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager) {}

  /**
   * Enqueue a danmaku for persistence. Fire-and-forget — no promise to await.
   * The caller (Bridge) runs on the WS receive path, so we never block it.
   */
  enqueue(evt: DanmakuEvent, opts: PersistOptions): void {
    if (this.queue.length >= this.MAX_QUEUE) {
      // Drop oldest; the DB is clearly behind and keeping new data matters more.
      this.queue.shift();
      logger.warn('[DanmakuStore] queue full — dropping oldest entry');
    }
    const normalized = evt.text.trim().replace(/\s+/g, ' ').toLowerCase();
    const record: Pending = {
      roomId: opts.roomId,
      uid: evt.uid,
      username: evt.username,
      text: evt.text,
      normalizedText: normalized,
      medalName: evt.medalName,
      medalLevel: evt.medalLevel,
      guardLevel: evt.guardLevel,
      mentionsStreamer: opts.mentionsStreamer ?? false,
      batchId: opts.batchId,
      receivedAt: new Date(evt.timestamp),
    };
    this.queue.push(record);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const accessor = this.databaseManager.getAdapter().getModel('bilibiliDanmaku');
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;
        try {
          await accessor.create(next);
        } catch (err) {
          logger.warn('[DanmakuStore] insert failed (dropped):', err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** For tests / graceful shutdown — wait for the current queue to drain. */
  async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

// Keeps the vector index equal to its two sources: the active `memory_facts` rows and the
// manual.txt files.
//
// Rows update the index as they are written (MemoryFactStore); a whole group is reconciled at
// startup, daily and on `/memory_sync`. Manual files change outside the bot's write path (an
// editor, the webui), so the memory directory is watched and a changed slot is reconciled once
// its file settles.

import { type FSWatcher, mkdirSync, watch } from 'node:fs';
import { inject, singleton } from 'tsyringe';
import { logger } from '@/utils/logger';
import { ManualMemoryStore, type ManualSlot } from './ManualMemoryStore';
import { MemoryFactStore } from './MemoryFactStore';
import { MemoryIndex } from './MemoryIndex';

/** Editors write a file in several steps (truncate, write, rename); wait for the last one. */
const MANUAL_SETTLE_MS = 500;

@singleton()
export class MemoryIndexSync {
  private watcher: FSWatcher | null = null;
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @inject(MemoryFactStore) private readonly facts: MemoryFactStore,
    @inject(ManualMemoryStore) private readonly manual: ManualMemoryStore,
    @inject(MemoryIndex) private readonly index: MemoryIndex,
  ) {}

  isEnabled(): boolean {
    return this.index.isEnabled();
  }

  /** Groups with an active fact or a manual file. */
  async listGroupIds(): Promise<string[]> {
    const groupIds = new Set(await this.facts.listGroupIds());
    for (const slot of this.manual.listSlots()) {
      groupIds.add(slot.groupId);
    }
    return [...groupIds].sort();
  }

  /** Make the group's collection hold exactly its active rows and its manual lines. */
  async reindexGroup(groupId: string): Promise<{ upserted: number; removed: number }> {
    const manual = this.manual
      .listSlots()
      .filter((slot) => slot.groupId === groupId)
      .flatMap((slot) => this.manual.getFacts(groupId, slot.userId));
    return this.index.reconcile(groupId, { auto: await this.facts.listGroup(groupId, 'active'), manual });
  }

  /** Reindex every group, then follow manual edits until `stop`. */
  start(): void {
    if (!this.isEnabled() || this.watcher) {
      return;
    }
    mkdirSync(this.manual.directory, { recursive: true });
    this.watcher = watch(this.manual.directory, { recursive: true }, (_event, filename) => {
      const slot = filename ? this.manual.slotAt(String(filename)) : null;
      if (slot) {
        this.settle(slot);
      }
    });
    this.watcher.on('error', (err) => logger.warn('[MemoryIndexSync] manual memory watcher failed:', err));
    this.enqueue(() => this.reindexAll());
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.settling.values()) {
      clearTimeout(timer);
    }
    this.settling.clear();
    await this.queue;
  }

  private settle(slot: ManualSlot): void {
    const key = `${slot.groupId}/${slot.userId}`;
    clearTimeout(this.settling.get(key));
    this.settling.set(
      key,
      setTimeout(() => {
        this.settling.delete(key);
        this.enqueue(() => this.syncManualSlot(slot));
      }, MANUAL_SETTLE_MS),
    );
  }

  private async syncManualSlot({ groupId, userId }: ManualSlot): Promise<void> {
    const { upserted, removed } = await this.index.reconcileManualSlot(
      groupId,
      userId,
      this.manual.getFacts(groupId, userId),
    );
    if (upserted > 0 || removed > 0) {
      logger.info(
        `[MemoryIndexSync] manual memory group=${groupId} slot=${userId} upserted=${upserted} removed=${removed}`,
      );
    }
  }

  private async reindexAll(): Promise<void> {
    for (const groupId of await this.listGroupIds()) {
      const { upserted, removed } = await this.reindexGroup(groupId);
      logger.info(`[MemoryIndexSync] reindexed group=${groupId} upserted=${upserted} removed=${removed}`);
    }
  }

  /** Index writes run one at a time, so two reconciles never diff against each other's half-done work. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err) => {
      logger.warn('[MemoryIndexSync] index sync failed; the next reconcile repairs it:', err);
    });
  }
}

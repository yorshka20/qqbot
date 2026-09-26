// Automatic memory facts: the `memory_facts` rows, and the only writer of them.
//
// The rows are the source of truth; every mutation here updates the vector index right after
// the row. An index failure does not undo the row: it is logged, and `reindexGroup` (daily,
// `/memory_sync`, `bun run memory reindex`) brings the index back to the rows.

import { inject, singleton } from 'tsyringe';
import { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryFact } from '@/database/models/types';
import { logger } from '@/utils/logger';
import { MemoryIndex } from './MemoryIndex';

export interface NewMemoryFact {
  groupId: string;
  userId: string;
  scope: string;
  content: string;
  durability: MemoryFact['durability'];
  firstSeen: number;
  lastConfirmedAt: number;
  confirmCount: number;
}

export interface MemoryFactPatch {
  scope?: string;
  content?: string;
  durability?: MemoryFact['durability'];
}

@singleton()
export class MemoryFactStore {
  constructor(
    @inject(DatabaseManager) private readonly databaseManager: DatabaseManager,
    @inject(MemoryIndex) private readonly index: MemoryIndex,
  ) {}

  private model() {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      throw new Error('[MemoryFactStore] database is not connected');
    }
    return adapter.getModel('memoryFacts');
  }

  /** One slot's facts in the order they were first seen; all statuses unless one is given. */
  listSlot(groupId: string, userId: string, status?: MemoryFact['status']): Promise<MemoryFact[]> {
    return this.model().find({ groupId, userId, status }, { orderBy: 'firstSeen', order: 'asc' });
  }

  listGroup(groupId: string, status?: MemoryFact['status']): Promise<MemoryFact[]> {
    return this.model().find({ groupId, status }, { orderBy: 'firstSeen', order: 'asc' });
  }

  listAll(): Promise<MemoryFact[]> {
    return this.model().find({}, { orderBy: 'firstSeen', order: 'asc' });
  }

  async listGroupIds(): Promise<string[]> {
    const facts = await this.model().find({ status: 'active' });
    return [...new Set(facts.map((fact) => fact.groupId))].sort();
  }

  isIndexed(): boolean {
    return this.index.isEnabled();
  }

  /** Make the group's vector index hold exactly its active rows. */
  async reindexGroup(groupId: string): Promise<{ upserted: number; removed: number }> {
    return this.index.reconcile(groupId, await this.listGroup(groupId, 'active'));
  }

  get(id: string): Promise<MemoryFact | null> {
    return this.model().findById(id);
  }

  async add(facts: NewMemoryFact[]): Promise<MemoryFact[]> {
    const model = this.model();
    const created: MemoryFact[] = [];
    for (const fact of facts) {
      created.push(await model.create({ ...fact, status: 'active', hitCount: 0 }));
    }
    await this.syncIndex(() => this.index.upsert(created));
    return created;
  }

  async confirm(ids: string[], at: number): Promise<void> {
    const model = this.model();
    for (const id of ids) {
      const fact = await model.findById(id);
      if (fact) {
        await model.update(id, { confirmCount: fact.confirmCount + 1, lastConfirmedAt: at });
      }
    }
  }

  async recordHits(ids: string[], at: number): Promise<void> {
    const model = this.model();
    for (const id of ids) {
      const fact = await model.findById(id);
      if (fact) {
        await model.update(id, { hitCount: fact.hitCount + 1, lastHitAt: at });
      }
    }
  }

  async markReviewed(ids: string[], at: number): Promise<void> {
    const model = this.model();
    for (const id of ids) {
      await model.update(id, { reviewedAt: at });
    }
  }

  /** Newer information replaced or contradicted these facts. */
  supersede(groupId: string, ids: string[], reason: string, supersededBy?: string): Promise<void> {
    return this.deactivate(groupId, ids, { status: 'superseded', statusReason: reason, supersededBy });
  }

  /** A review judged these facts temporary or no longer relevant. */
  retire(groupId: string, ids: string[], reason: string): Promise<void> {
    return this.deactivate(groupId, ids, { status: 'retired', statusReason: reason });
  }

  /** Change a fact in place (a webui correction, a review relabel); it keeps its id, history and signals. */
  async patch(id: string, patch: MemoryFactPatch): Promise<MemoryFact | null> {
    const model = this.model();
    if (!(await model.findById(id))) {
      return null;
    }
    const updated = await model.update(id, patch);
    if (updated.status === 'active') {
      await this.syncIndex(() => this.index.upsert([updated]));
    }
    return updated;
  }

  /** A hand deletion from the webui: the row is gone, not kept as history. */
  async delete(id: string): Promise<boolean> {
    const model = this.model();
    const fact = await model.findById(id);
    if (!fact) {
      return false;
    }
    await model.delete(id);
    await this.syncIndex(() => this.index.remove(fact.groupId, [id]));
    return true;
  }

  private async deactivate(
    groupId: string,
    ids: string[],
    change: Pick<MemoryFact, 'status' | 'statusReason' | 'supersededBy'>,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const model = this.model();
    for (const id of ids) {
      await model.update(id, change);
    }
    await this.syncIndex(() => this.index.remove(groupId, ids));
  }

  private async syncIndex(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (err) {
      logger.warn('[MemoryFactStore] index write failed; the next reconcile repairs it:', err);
    }
  }
}

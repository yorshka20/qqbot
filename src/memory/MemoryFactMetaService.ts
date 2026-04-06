// Memory Fact Metadata Service - tracks quality signals for memory facts
// Uses direct bun:sqlite access (not ModelAccessor) for batch operations and custom SQL

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { logger } from '@/utils/logger';

export interface FactMeta {
  factHash: string;
  groupId: string;
  userId: string;
  scope: string;
  source: 'manual' | 'llm_extract';
  firstSeen: number;
  lastReinforced: number;
  reinforceCount: number;
  hitCount: number;
  status: 'active' | 'stale';
  staleSince?: number;
}

export class MemoryFactMetaService {
  constructor(private db: Database) {}

  // ─── Hash computation ───

  static computeFactHash(groupId: string, userId: string, scope: string, content: string): string {
    const normalized = MemoryFactMetaService.normalizeContent(content);
    const input = `${groupId}:${userId}:${scope}:${normalized}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  static normalizeContent(content: string): string {
    return content
      .toLowerCase()
      .replace(/[\s。！？；.!?;，,、：:""''（）()[\]【】]+/g, ' ')
      .trim();
  }

  // ─── Queries ───

  getFactMeta(groupId: string, userId: string, source?: 'manual' | 'llm_extract'): Map<string, FactMeta> {
    let rows: FactMeta[];
    if (source) {
      rows = this.db
        .query('SELECT * FROM memory_fact_meta WHERE groupId = ? AND userId = ? AND source = ?')
        .all(groupId, userId, source) as FactMeta[];
    } else {
      rows = this.db
        .query('SELECT * FROM memory_fact_meta WHERE groupId = ? AND userId = ?')
        .all(groupId, userId) as FactMeta[];
    }
    const map = new Map<string, FactMeta>();
    for (const row of rows) map.set(row.factHash, row);
    return map;
  }

  getActiveFacts(groupId: string, userId: string): FactMeta[] {
    return this.db
      .query('SELECT * FROM memory_fact_meta WHERE groupId = ? AND userId = ? AND status = ?')
      .all(groupId, userId, 'active') as FactMeta[];
  }

  getAllActiveFactsForGroup(groupId: string): FactMeta[] {
    return this.db
      .query('SELECT * FROM memory_fact_meta WHERE groupId = ? AND status = ?')
      .all(groupId, 'active') as FactMeta[];
  }

  // ─── Writes ───

  insertFact(meta: Omit<FactMeta, 'hitCount' | 'status' | 'staleSince'>): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT OR IGNORE INTO memory_fact_meta
        (id, factHash, groupId, userId, scope, source, firstSeen, lastReinforced, reinforceCount, hitCount, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        meta.factHash,
        meta.groupId,
        meta.userId,
        meta.scope,
        meta.source,
        meta.firstSeen,
        meta.lastReinforced,
        meta.reinforceCount,
        now,
        now,
      );
  }

  reinforceFact(factHash: string): void {
    this.db
      .query(
        `UPDATE memory_fact_meta
      SET lastReinforced = ?, reinforceCount = reinforceCount + 1, updatedAt = ?
      WHERE factHash = ?`,
      )
      .run(Date.now(), new Date().toISOString(), factHash);
  }

  activateFact(factHash: string): void {
    this.db
      .query(
        `UPDATE memory_fact_meta
      SET status = 'active', staleSince = NULL, updatedAt = ?
      WHERE factHash = ?`,
      )
      .run(new Date().toISOString(), factHash);
  }

  markStale(factHash: string): void {
    this.db
      .query(
        `UPDATE memory_fact_meta
      SET status = 'stale', staleSince = ?, updatedAt = ?
      WHERE factHash = ?`,
      )
      .run(Date.now(), new Date().toISOString(), factHash);
  }

  deleteFact(factHash: string): void {
    this.db.query('DELETE FROM memory_fact_meta WHERE factHash = ?').run(factHash);
  }

  incrementHitCount(factHashes: string[]): void {
    if (factHashes.length === 0) return;
    const placeholders = factHashes.map(() => '?').join(',');
    this.db
      .query(
        `UPDATE memory_fact_meta
      SET hitCount = hitCount + 1, updatedAt = ?
      WHERE factHash IN (${placeholders})`,
      )
      .run(new Date().toISOString(), ...factHashes);
  }

  // ─── Cleanup queries ───

  /**
   * Get stale facts older than given threshold (for hard deletion).
   * Manual facts are never returned.
   */
  getStaleFacts(olderThanMs: number): FactMeta[] {
    return this.db
      .query(
        `SELECT * FROM memory_fact_meta
      WHERE status = 'stale' AND staleSince < ? AND source != 'manual'`,
      )
      .all(Date.now() - olderThanMs) as FactMeta[];
  }

  /**
   * Get zombie facts: active but long-unreinforced with zero hits.
   * Manual facts are never returned.
   */
  getZombieFacts(noReinforceSinceMs: number): FactMeta[] {
    return this.db
      .query(
        `SELECT * FROM memory_fact_meta
      WHERE status = 'active' AND lastReinforced < ? AND hitCount = 0 AND source != 'manual'`,
      )
      .all(Date.now() - noReinforceSinceMs) as FactMeta[];
  }

  /**
   * Batch delete by fact hashes.
   */
  deleteMany(factHashes: string[]): void {
    if (factHashes.length === 0) return;
    const placeholders = factHashes.map(() => '?').join(',');
    this.db.query(`DELETE FROM memory_fact_meta WHERE factHash IN (${placeholders})`).run(...factHashes);
  }

  /**
   * Migrate metadata from old hash to new hash (for content rewrites).
   */
  migrateFact(oldHash: string, newHash: string, newScope: string): void {
    const old = this.db.query('SELECT * FROM memory_fact_meta WHERE factHash = ?').get(oldHash) as FactMeta | null;
    if (!old) return;

    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT OR REPLACE INTO memory_fact_meta
        (id, factHash, groupId, userId, scope, source, firstSeen, lastReinforced, reinforceCount, hitCount, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        newHash,
        old.groupId,
        old.userId,
        newScope,
        old.source,
        old.firstSeen,
        Date.now(),
        old.reinforceCount + 1,
        old.hitCount,
        now,
        now,
      );
    this.deleteFact(oldHash);
    logger.debug(`[MemoryFactMetaService] Migrated fact ${oldHash.slice(0, 8)} → ${newHash.slice(0, 8)}`);
  }
}

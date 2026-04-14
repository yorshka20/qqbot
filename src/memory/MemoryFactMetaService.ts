// Memory Fact Metadata Service - tracks quality signals for memory facts
// Uses direct bun:sqlite access (not ModelAccessor) for batch operations and custom SQL

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';

export interface FactMeta {
  factHash: string;
  groupId: string;
  userId: string;
  scope: string;
  source: 'manual' | 'llm_extract';
  normalizedContent: string;
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
        (id, factHash, groupId, userId, scope, source, normalizedContent, firstSeen, lastReinforced, reinforceCount, hitCount, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
      )
      .run(
        randomUUID(),
        meta.factHash,
        meta.groupId,
        meta.userId,
        meta.scope,
        meta.source,
        meta.normalizedContent,
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

  // ─── Batch queries ───

  /**
   * Get fact metadata for a list of hashes (for quality scoring during retrieval).
   */
  getFactMetaByHashes(hashes: string[]): Map<string, FactMeta> {
    if (hashes.length === 0) return new Map();
    const placeholders = hashes.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT * FROM memory_fact_meta WHERE factHash IN (${placeholders})`)
      .all(...hashes) as FactMeta[];
    const map = new Map<string, FactMeta>();
    for (const row of rows) map.set(row.factHash, row);
    return map;
  }

  /**
   * Get all facts for a group (for status/overview API).
   */
  getAllFactsForGroup(groupId: string): FactMeta[] {
    return this.db.query('SELECT * FROM memory_fact_meta WHERE groupId = ?').all(groupId) as FactMeta[];
  }

  /**
   * Get summary stats across all groups.
   */
  getGlobalStats(): {
    totalFacts: number;
    activeFacts: number;
    staleFacts: number;
    manualFacts: number;
    autoFacts: number;
  } {
    const total = (this.db.query('SELECT COUNT(*) as c FROM memory_fact_meta').get() as { c: number }).c;
    const active = (
      this.db.query("SELECT COUNT(*) as c FROM memory_fact_meta WHERE status = 'active'").get() as { c: number }
    ).c;
    const stale = (
      this.db.query("SELECT COUNT(*) as c FROM memory_fact_meta WHERE status = 'stale'").get() as { c: number }
    ).c;
    const manual = (
      this.db.query("SELECT COUNT(*) as c FROM memory_fact_meta WHERE source = 'manual'").get() as { c: number }
    ).c;
    const auto = (
      this.db.query("SELECT COUNT(*) as c FROM memory_fact_meta WHERE source = 'llm_extract'").get() as { c: number }
    ).c;
    return { totalFacts: total, activeFacts: active, staleFacts: stale, manualFacts: manual, autoFacts: auto };
  }

  /**
   * Get per-group summary stats.
   */
  getGroupStats(): Array<{
    groupId: string;
    totalFacts: number;
    activeFacts: number;
    staleFacts: number;
    manualFacts: number;
    autoFacts: number;
    userCount: number;
  }> {
    const rows = this.db
      .query(`
      SELECT groupId,
        COUNT(*) as totalFacts,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activeFacts,
        SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) as staleFacts,
        SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) as manualFacts,
        SUM(CASE WHEN source = 'llm_extract' THEN 1 ELSE 0 END) as autoFacts,
        COUNT(DISTINCT userId) as userCount
      FROM memory_fact_meta
      GROUP BY groupId
    `)
      .all() as Array<{
      groupId: string;
      totalFacts: number;
      activeFacts: number;
      staleFacts: number;
      manualFacts: number;
      autoFacts: number;
      userCount: number;
    }>;
    return rows;
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
   * Upgrade source from llm_extract to manual if a matching hash exists.
   * Returns true if an upgrade happened.
   */
  upgradeSource(factHash: string): boolean {
    const existing = this.db
      .query("SELECT * FROM memory_fact_meta WHERE factHash = ? AND source = 'llm_extract'")
      .get(factHash) as FactMeta | null;
    if (!existing) return false;

    this.db
      .query(
        `UPDATE memory_fact_meta
      SET source = 'manual', reinforceCount = reinforceCount + 1, lastReinforced = ?, updatedAt = ?
      WHERE factHash = ?`,
      )
      .run(Date.now(), new Date().toISOString(), factHash);
    logger.debug(`[MemoryFactMetaService] Upgraded source to manual for ${factHash.slice(0, 8)}`);
    return true;
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
  migrateFact(oldHash: string, newHash: string, newScope: string, newNormalizedContent: string): void {
    const old = this.db.query('SELECT * FROM memory_fact_meta WHERE factHash = ?').get(oldHash) as FactMeta | null;
    if (!old) return;

    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT OR REPLACE INTO memory_fact_meta
        (id, factHash, groupId, userId, scope, source, normalizedContent, firstSeen, lastReinforced, reinforceCount, hitCount, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        randomUUID(),
        newHash,
        old.groupId,
        old.userId,
        newScope,
        old.source,
        newNormalizedContent,
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

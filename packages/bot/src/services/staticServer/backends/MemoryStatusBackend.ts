/**
 * Memory status backend: REST API (/api/memory) for memory quality observation.
 *
 * Provides overview of memory fact metadata from SQLite:
 * - Global stats (total/active/stale/manual/auto counts)
 * - Per-group breakdown
 * - Per-user detail within a group
 * - Individual fact list with quality signals
 *
 * API contract:
 * - GET /api/memory/stats                          → global summary
 * - GET /api/memory/groups                          → per-group stats
 * - GET /api/memory/group/:groupId                  → facts for a group (all users)
 * - GET /api/memory/group/:groupId/user/:userId     → facts for a specific user
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { MemoryFactMetaService } from '@/memory/MemoryFactMetaService';
import { logger } from '@/utils/logger';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/memory';

export class MemoryStatusBackend implements Backend {
  readonly prefix = API_PREFIX;
  private factMetaService: MemoryFactMetaService | null = null;
  private initialized = false;

  private ensureInit(): boolean {
    if (this.initialized) return this.factMetaService !== null;
    this.initialized = true;
    try {
      this.factMetaService = getContainer().resolve<MemoryFactMetaService>(DITokens.MEMORY_FACT_META_SERVICE);
    } catch {
      logger.debug('[MemoryStatusBackend] MemoryFactMetaService not available');
    }
    return this.factMetaService !== null;
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    if (!this.ensureInit()) {
      return errorResponse('Memory metadata service not available (SQLite required)', 503);
    }

    const subPath = pathname.slice(API_PREFIX.length);

    // GET /api/memory/stats
    if (subPath === '/stats' || subPath === '/stats/') {
      return this.handleGlobalStats();
    }

    // GET /api/memory/groups
    if (subPath === '/groups' || subPath === '/groups/') {
      return this.handleGroupStats();
    }

    // GET /api/memory/group/:groupId/user/:userId
    const userMatch = subPath.match(/^\/group\/([^/]+)\/user\/([^/]+)\/?$/);
    if (userMatch) {
      return this.handleUserFacts(userMatch[1], userMatch[2]);
    }

    // GET /api/memory/group/:groupId
    const groupMatch = subPath.match(/^\/group\/([^/]+)\/?$/);
    if (groupMatch) {
      return this.handleGroupFacts(groupMatch[1]);
    }

    return errorResponse('Not found', 404);
  }

  private handleGlobalStats(): Response {
    try {
      const stats = this.factMetaService!.getGlobalStats();
      return jsonResponse({ stats });
    } catch (err) {
      logger.error('[MemoryStatusBackend] global stats error:', err);
      return errorResponse('Failed to get global stats', 500);
    }
  }

  private handleGroupStats(): Response {
    try {
      const groups = this.factMetaService!.getGroupStats();
      return jsonResponse({ groups });
    } catch (err) {
      logger.error('[MemoryStatusBackend] group stats error:', err);
      return errorResponse('Failed to get group stats', 500);
    }
  }

  private handleGroupFacts(groupId: string): Response {
    try {
      const facts = this.factMetaService!.getAllFactsForGroup(groupId);
      // Group by userId for structured response
      const byUser = new Map<string, typeof facts>();
      for (const fact of facts) {
        const existing = byUser.get(fact.userId);
        if (existing) {
          existing.push(fact);
        } else {
          byUser.set(fact.userId, [fact]);
        }
      }
      const users = [...byUser.entries()].map(([userId, userFacts]) => ({
        userId,
        totalFacts: userFacts.length,
        activeFacts: userFacts.filter((f) => f.status === 'active').length,
        staleFacts: userFacts.filter((f) => f.status === 'stale').length,
        manualFacts: userFacts.filter((f) => f.source === 'manual').length,
        autoFacts: userFacts.filter((f) => f.source === 'llm_extract').length,
      }));
      return jsonResponse({ groupId, totalFacts: facts.length, users });
    } catch (err) {
      logger.error('[MemoryStatusBackend] group facts error:', err);
      return errorResponse('Failed to get group facts', 500);
    }
  }

  private handleUserFacts(groupId: string, userId: string): Response {
    try {
      const allMeta = this.factMetaService!.getFactMeta(groupId, userId);
      const facts = [...allMeta.values()].map((f) => ({
        factHash: f.factHash,
        scope: f.scope,
        source: f.source,
        status: f.status,
        reinforceCount: f.reinforceCount,
        hitCount: f.hitCount,
        firstSeen: f.firstSeen,
        lastReinforced: f.lastReinforced,
        staleSince: f.staleSince,
        ageDays: Math.round((Date.now() - f.lastReinforced) / 86_400_000),
      }));
      // Sort: active first, then by lastReinforced desc
      facts.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        return b.lastReinforced - a.lastReinforced;
      });
      return jsonResponse({ groupId, userId, totalFacts: facts.length, facts });
    } catch (err) {
      logger.error('[MemoryStatusBackend] user facts error:', err);
      return errorResponse('Failed to get user facts', 500);
    }
  }
}

/**
 * Memory backend: REST API (/api/memory) for reading and correcting memory.
 *
 * Shows each layer from its source of truth: manual memory from the slot's manual.txt,
 * automatic memory from the `memory_facts` rows (every status, with their signals).
 * The vector index is derived and never shown.
 *
 * API contract:
 * - GET    /api/memory/stats                            → fact counts by status, manual slot count
 * - GET    /api/memory/groups                           → the same per group
 * - GET    /api/memory/group/:groupId                   → the group's slots; the group's own memory is one slot
 * - GET    /api/memory/group/:groupId/user/:userId      → one slot: manual.txt text and every fact
 * - PUT    /api/memory/group/:groupId/manual            → replace the group's manual.txt
 * - PUT    /api/memory/group/:groupId/user/:userId/manual → replace that user's manual.txt
 * - PUT    /api/memory/fact/:id                         → correct a fact's content, scope or durability
 * - DELETE /api/memory/fact/:id                         → delete a fact
 */

import { getContainer } from '@/core/DIContainer';
import { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import { DatabaseManager } from '@/database/DatabaseManager';
import type { MemoryFact } from '@/database/models/types';
import { MemoryFactStore } from '@/memory/MemoryFactStore';
import { MemoryService } from '@/memory/MemoryService';
import { GROUP_MEMORY_USER_ID } from '@/memory/memoryConstants';
import { MemoryDisplayNames, memorySubjectKey } from '@/memory/memoryDisplayNames';
import { isAllowedScope } from '@/memory/memoryScopes';
import { logger } from '@/utils/logger';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/memory';

interface FactCounts {
  activeFacts: number;
  supersededFacts: number;
  retiredFacts: number;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function countFacts(facts: MemoryFact[]): FactCounts {
  return {
    activeFacts: facts.filter((f) => f.status === 'active').length,
    supersededFacts: facts.filter((f) => f.status === 'superseded').length,
    retiredFacts: facts.filter((f) => f.status === 'retired').length,
  };
}

function toEntry(fact: MemoryFact) {
  return {
    id: fact.id,
    scope: fact.scope,
    content: fact.content,
    durability: fact.durability,
    status: fact.status,
    statusReason: fact.statusReason,
    supersededBy: fact.supersededBy,
    firstSeen: fact.firstSeen,
    lastConfirmedAt: fact.lastConfirmedAt,
    confirmCount: fact.confirmCount,
    hitCount: fact.hitCount,
    lastHitAt: fact.lastHitAt,
    reviewedAt: fact.reviewedAt,
  };
}

export class MemoryStatusBackend implements Backend {
  readonly prefix = API_PREFIX;

  private memory(): MemoryService {
    return getContainer().resolve(MemoryService);
  }

  private store(): MemoryFactStore {
    return getContainer().resolve(MemoryFactStore);
  }

  /** Names come from the SQLite messages table; other databases show ids only. */
  private names(): MemoryDisplayNames | null {
    const adapter = getContainer().resolve(DatabaseManager).getAdapter();
    const db = adapter instanceof SQLiteAdapter ? adapter.getRawDb() : null;
    return db ? new MemoryDisplayNames(db) : null;
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;
    const subPath = pathname.slice(API_PREFIX.length);
    try {
      const factMatch = subPath.match(/^\/fact\/([^/]+)\/?$/);
      if (factMatch) {
        const id = decodePathSegment(factMatch[1]);
        if (req.method === 'PUT') return await this.handlePutFact(id, req);
        if (req.method === 'DELETE') return await this.handleDeleteFact(id);
        return errorResponse('Method not allowed', 405);
      }
      if (req.method === 'PUT') {
        return await this.handlePutManual(subPath, req);
      }
      if (req.method !== 'GET') {
        return errorResponse('Method not allowed', 405);
      }
      if (subPath === '/stats' || subPath === '/stats/') {
        return await this.handleStats();
      }
      if (subPath === '/groups' || subPath === '/groups/') {
        return await this.handleGroups();
      }
      const userMatch = subPath.match(/^\/group\/([^/]+)\/user\/([^/]+)\/?$/);
      if (userMatch) {
        return await this.handleSlot(decodePathSegment(userMatch[1]), decodePathSegment(userMatch[2]));
      }
      const groupMatch = subPath.match(/^\/group\/([^/]+)\/?$/);
      if (groupMatch) {
        return await this.handleGroup(decodePathSegment(groupMatch[1]));
      }
      return errorResponse('Not found', 404);
    } catch (err) {
      logger.error('[MemoryStatusBackend] request failed:', subPath, err);
      return errorResponse('Memory request failed', 500);
    }
  }

  private async handleStats(): Promise<Response> {
    const facts = await this.store().listAll();
    return jsonResponse({ stats: { ...countFacts(facts), manualSlots: this.memory().listManualSlots().length } });
  }

  private async handleGroups(): Promise<Response> {
    const facts = await this.store().listAll();
    const manual = this.memory().listManualSlots();
    const groupIds = [...new Set([...facts.map((f) => f.groupId), ...manual.map((s) => s.groupId)])].sort();
    const names = this.names()?.lookupLatestGroupNames(groupIds) ?? new Map<string, string>();
    const groups = groupIds.map((groupId) => {
      const groupFacts = facts.filter((f) => f.groupId === groupId);
      const groupManual = manual.filter((s) => s.groupId === groupId);
      const slotCount = new Set([...groupFacts.map((f) => f.userId), ...groupManual.map((s) => s.userId)]).size;
      const groupName = names.get(groupId);
      return {
        groupId,
        ...(groupName ? { groupName } : {}),
        slotCount,
        manualSlots: groupManual.length,
        ...countFacts(groupFacts),
      };
    });
    return jsonResponse({ groups });
  }

  private async handleGroup(groupId: string): Promise<Response> {
    const facts = await this.store().listGroup(groupId);
    const manualUserIds = new Set(
      this.memory()
        .listManualSlots()
        .filter((s) => s.groupId === groupId)
        .map((s) => s.userId),
    );
    const userIds = [...new Set([...facts.map((f) => f.userId), ...manualUserIds])];
    const names = this.names();
    const nicknames =
      names?.lookupLatestNicknames(
        userIds.filter((u) => u !== GROUP_MEMORY_USER_ID).map((userId) => ({ groupId, userId })),
      ) ?? new Map<string, string>();
    const slots = userIds
      .map((userId) => {
        const isGroupMemory = userId === GROUP_MEMORY_USER_ID;
        const nickname = isGroupMemory ? undefined : nicknames.get(memorySubjectKey(groupId, userId));
        return {
          userId,
          ...(nickname ? { nickname } : {}),
          isGroupMemory,
          hasManualText: manualUserIds.has(userId),
          ...countFacts(facts.filter((f) => f.userId === userId)),
        };
      })
      .sort((a, b) => {
        if (a.isGroupMemory !== b.isGroupMemory) {
          return a.isGroupMemory ? -1 : 1;
        }
        return (a.nickname ?? a.userId).localeCompare(b.nickname ?? b.userId, 'zh-CN');
      });
    const groupName = names?.lookupLatestGroupNames([groupId]).get(groupId);
    return jsonResponse({ groupId, ...(groupName ? { groupName } : {}), slots });
  }

  private async handleSlot(groupId: string, userId: string): Promise<Response> {
    const isGroupMemory = userId === GROUP_MEMORY_USER_ID;
    const names = this.names();
    const nickname = isGroupMemory
      ? undefined
      : names?.lookupLatestNicknames([{ groupId, userId }]).get(memorySubjectKey(groupId, userId));
    const groupName = names?.lookupLatestGroupNames([groupId]).get(groupId);
    const facts = await this.store().listSlot(groupId, userId);
    return jsonResponse({
      groupId,
      ...(groupName ? { groupName } : {}),
      userId,
      ...(nickname ? { nickname } : {}),
      isGroupMemory,
      manualText: this.memory().getManualText(groupId, userId),
      facts: facts.map(toEntry),
    });
  }

  private async readJson(req: Request): Promise<Record<string, unknown> | null> {
    try {
      const body = (await req.json()) as unknown;
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async handlePutManual(subPath: string, req: Request): Promise<Response> {
    const userMatch = subPath.match(/^\/group\/([^/]+)\/user\/([^/]+)\/manual\/?$/);
    const groupMatch = subPath.match(/^\/group\/([^/]+)\/manual\/?$/);
    const groupId = userMatch
      ? decodePathSegment(userMatch[1])
      : groupMatch
        ? decodePathSegment(groupMatch[1])
        : undefined;
    const userId = userMatch ? decodePathSegment(userMatch[2]) : groupMatch ? GROUP_MEMORY_USER_ID : undefined;
    if (!groupId || !userId) {
      return errorResponse('Not found', 404);
    }
    const body = await this.readJson(req);
    if (!body || typeof body.content !== 'string') {
      return errorResponse('content must be a string', 400);
    }
    await this.memory().saveManualMemory(groupId, userId, body.content);
    return jsonResponse({ saved: true });
  }

  private async handlePutFact(id: string, req: Request): Promise<Response> {
    const body = await this.readJson(req);
    if (!body) {
      return errorResponse('Invalid JSON', 400);
    }
    const store = this.store();
    const fact = await store.get(id);
    if (!fact) {
      return errorResponse('Fact not found', 404);
    }
    const content = typeof body.content === 'string' ? body.content.trim() : fact.content;
    const scope = typeof body.scope === 'string' ? body.scope.trim().toLowerCase() : fact.scope;
    const durability = body.durability === undefined ? fact.durability : body.durability;
    if (!content) {
      return errorResponse('content must not be empty', 400);
    }
    if (!isAllowedScope(fact.userId, scope)) {
      return errorResponse(`scope "${scope}" is not allowed in this memory`, 400);
    }
    if (durability !== 'stable' && durability !== 'transient') {
      return errorResponse('durability must be stable or transient', 400);
    }
    const updated = await store.patch(id, { content, scope, durability });
    return updated ? jsonResponse({ fact: toEntry(updated) }) : errorResponse('Fact not found', 404);
  }

  private async handleDeleteFact(id: string): Promise<Response> {
    const deleted = await this.store().delete(id);
    return deleted ? jsonResponse({ deleted: true }) : errorResponse('Fact not found', 404);
  }
}

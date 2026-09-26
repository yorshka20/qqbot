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
 * - GET /api/memory/browse                          → groups, users, facts, and manual.txt text
 * - PUT /api/memory/group/:groupId/manual           → replace that group's manual.txt
 * - PUT /api/memory/group/:groupId/user/:userId/manual → replace that user's manual.txt
 * - GET /api/memory/stats                          → global summary
 * - GET /api/memory/groups                          → per-group stats
 * - GET /api/memory/group/:groupId                  → users in that group; group memory is one user
 * - GET /api/memory/group/:groupId/user/:userId     → that slot's manual.txt and auto.txt
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { type MemoryFactMetaService, memorySubjectKey } from '@/memory/MemoryFactMetaService';
import { GROUP_MEMORY_USER_ID, MemoryService } from '@/memory/MemoryService';
import { logger } from '@/utils/logger';
import { assembleMemoryBrowse } from './memoryBrowse';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/memory';

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class MemoryStatusBackend implements Backend {
  readonly prefix = API_PREFIX;
  private factMetaService: MemoryFactMetaService | null = null;
  private memoryService: MemoryService | null = null;
  private initialized = false;

  private ensureInit(): boolean {
    if (this.initialized) return this.factMetaService !== null;
    this.initialized = true;
    const container = getContainer();
    try {
      this.factMetaService = container.resolve<MemoryFactMetaService>(DITokens.MEMORY_FACT_META_SERVICE);
    } catch {
      logger.debug('[MemoryStatusBackend] MemoryFactMetaService not available');
    }
    try {
      this.memoryService = container.resolve(MemoryService);
    } catch (err) {
      logger.debug('[MemoryStatusBackend] MemoryService not available:', err);
    }
    return this.factMetaService !== null;
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;
    if (req.method !== 'GET' && req.method !== 'PUT') return errorResponse('Method not allowed', 405);

    if (!this.ensureInit()) {
      return errorResponse('Memory metadata service not available (SQLite required)', 503);
    }

    const subPath = pathname.slice(API_PREFIX.length);

    if (req.method === 'PUT') {
      return this.handlePutManual(subPath, req);
    }

    // GET /api/memory/browse
    if (subPath === '/browse' || subPath === '/browse/') {
      return this.handleBrowse();
    }

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
      return this.handleUserFacts(decodePathSegment(userMatch[1]), decodePathSegment(userMatch[2]));
    }

    // GET /api/memory/group/:groupId
    const groupMatch = subPath.match(/^\/group\/([^/]+)\/?$/);
    if (groupMatch) {
      return this.handleGroupFacts(decodePathSegment(groupMatch[1]));
    }

    return errorResponse('Not found', 404);
  }

  private service(): MemoryFactMetaService {
    const service = this.factMetaService;
    if (!service) {
      throw new Error('Memory metadata service not available');
    }
    return service;
  }

  private handleBrowse(): Response {
    try {
      const service = this.service();
      const facts = service.listAllFacts();
      const groupIds = [...new Set(facts.map((fact) => fact.groupId))];
      const groupNames = service.lookupLatestGroupNames(groupIds);
      const seen = new Set<string>();
      const subjects: Array<{ groupId: string; userId: string }> = [];
      for (const fact of facts) {
        if (fact.userId === GROUP_MEMORY_USER_ID) {
          continue;
        }
        const key = memorySubjectKey(fact.groupId, fact.userId);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        subjects.push({ groupId: fact.groupId, userId: fact.userId });
      }
      const nicknames = service.lookupLatestNicknames(subjects);
      return jsonResponse(assembleMemoryBrowse(facts, groupNames, nicknames));
    } catch (err) {
      logger.error('[MemoryStatusBackend] browse error:', err);
      return errorResponse('Failed to browse memory', 500);
    }
  }

  private handleGlobalStats(): Response {
    try {
      const stats = this.service().getGlobalStats();
      return jsonResponse({ stats });
    } catch (err) {
      logger.error('[MemoryStatusBackend] global stats error:', err);
      return errorResponse('Failed to get global stats', 500);
    }
  }

  private handleGroupStats(): Response {
    try {
      const service = this.service();
      const groups = service.getGroupStats();
      const names = service.lookupLatestGroupNames(groups.map((group) => group.groupId));
      return jsonResponse({
        groups: groups.map((group) => {
          const groupName = names.get(group.groupId);
          return groupName ? { ...group, groupName } : group;
        }),
      });
    } catch (err) {
      logger.error('[MemoryStatusBackend] group stats error:', err);
      return errorResponse('Failed to get group stats', 500);
    }
  }

  private handleGroupFacts(groupId: string): Response {
    try {
      const service = this.service();
      const facts = service.getAllFactsForGroup(groupId);
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
      const subjects = [...byUser.keys()]
        .filter((userId) => userId !== GROUP_MEMORY_USER_ID)
        .map((userId) => ({ groupId, userId }));
      const nicknames = service.lookupLatestNicknames(subjects);
      this.ensureGroupMemoryUser(groupId, byUser);
      const groupName = service.lookupLatestGroupNames([groupId]).get(groupId);
      const groupManual = this.readLayerText(groupId, GROUP_MEMORY_USER_ID, 'manual').trim();
      const users = [...byUser.entries()].map(([userId, userFacts]) => {
        const isGroupMemory = userId === GROUP_MEMORY_USER_ID;
        const nickname = isGroupMemory ? undefined : nicknames.get(memorySubjectKey(groupId, userId));
        return {
          userId,
          ...(nickname ? { nickname } : {}),
          isGroupMemory,
          ...(isGroupMemory && groupManual ? { hasManualText: true } : {}),
          totalFacts: userFacts.length,
          activeFacts: userFacts.filter((f) => f.status === 'active').length,
          staleFacts: userFacts.filter((f) => f.status === 'stale').length,
          manualFacts: userFacts.filter((f) => f.source === 'manual').length,
          autoFacts: userFacts.filter((f) => f.source === 'llm_extract').length,
        };
      });
      users.sort((a, b) => {
        if (a.isGroupMemory !== b.isGroupMemory) {
          return a.isGroupMemory ? -1 : 1;
        }
        const aName = a.nickname ?? a.userId;
        const bName = b.nickname ?? b.userId;
        return aName.localeCompare(bName, 'zh-CN');
      });
      return jsonResponse({
        groupId,
        ...(groupName ? { groupName } : {}),
        totalFacts: facts.length,
        users,
      });
    } catch (err) {
      logger.error('[MemoryStatusBackend] group facts error:', err);
      return errorResponse('Failed to get group facts', 500);
    }
  }

  private handleUserFacts(groupId: string, userId: string): Response {
    try {
      const service = this.service();
      const isGroupMemory = userId === GROUP_MEMORY_USER_ID;
      const nickname = isGroupMemory
        ? undefined
        : service.lookupLatestNicknames([{ groupId, userId }]).get(memorySubjectKey(groupId, userId));
      const groupName = service.lookupLatestGroupNames([groupId]).get(groupId);
      return jsonResponse({
        groupId,
        ...(groupName ? { groupName } : {}),
        userId,
        ...(nickname ? { nickname } : {}),
        isGroupMemory,
        manualText: this.readLayerText(groupId, userId, 'manual'),
        autoText: this.readLayerText(groupId, userId, 'auto'),
      });
    } catch (err) {
      logger.error('[MemoryStatusBackend] user facts error:', err);
      return errorResponse('Failed to get user facts', 500);
    }
  }

  /** A group's own memory is a user row even when it exists only as a file. */
  private ensureGroupMemoryUser<T>(groupId: string, byUser: Map<string, T[]>): void {
    if (byUser.has(GROUP_MEMORY_USER_ID)) {
      return;
    }
    const memory = this.memoryService;
    if (!memory) {
      return;
    }
    const manual = memory.getGroupMemoryTextByLayer(groupId, 'manual').trim();
    const auto = memory.getGroupMemoryTextByLayer(groupId, 'auto').trim();
    if (!manual && !auto) {
      return;
    }
    byUser.set(GROUP_MEMORY_USER_ID, []);
  }

  private readLayerText(groupId: string, userId: string, layer: 'manual' | 'auto'): string {
    const memory = this.memoryService;
    if (!memory) {
      return '';
    }
    if (userId === GROUP_MEMORY_USER_ID) {
      return memory.getGroupMemoryTextByLayer(groupId, layer);
    }
    return memory.getUserMemoryTextByLayer(groupId, userId, layer);
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
    const memory = this.memoryService;
    if (!memory) {
      return errorResponse('Memory service not available', 503);
    }
    let body: { content?: unknown };
    try {
      body = (await req.json()) as { content?: unknown };
    } catch {
      return errorResponse('Invalid JSON', 400);
    }
    if (typeof body.content !== 'string') {
      return errorResponse('content must be a string', 400);
    }
    try {
      const result = await memory.saveManualMemory(groupId, userId, body.content);
      return jsonResponse(result);
    } catch (err) {
      logger.error('[MemoryStatusBackend] save manual memory error:', err);
      return errorResponse('Failed to save manual memory', 500);
    }
  }
}

// Assemble the memory browser tree from fact rows plus display names.
// Group memory is stored under a sentinel user id; it is a slot, not a person.

import { type FactMeta, memorySubjectKey } from '@/memory/MemoryFactMetaService';
import { GROUP_MEMORY_USER_ID } from '@/memory/MemoryService';

export interface MemoryBrowseFact {
  factHash: string;
  scope: string;
  source: string;
  status: string;
  content: string;
  reinforceCount: number;
  hitCount: number;
  firstSeen: number;
  lastReinforced: number;
  staleSince?: number;
  ageDays: number;
}

export interface MemoryBrowseUser {
  userId: string;
  nickname?: string;
  isGroupMemory: boolean;
  /** Raw manual.txt. Empty when that slot has no hand-written file. */
  manualText: string;
  totalFacts: number;
  activeFacts: number;
  staleFacts: number;
  manualFacts: number;
  autoFacts: number;
  facts: MemoryBrowseFact[];
}

export interface ManualDocument {
  groupId: string;
  userId: string;
  content: string;
}

export interface MemoryBrowseGroup {
  groupId: string;
  groupName?: string;
  totalFacts: number;
  activeFacts: number;
  staleFacts: number;
  manualFacts: number;
  autoFacts: number;
  userCount: number;
  users: MemoryBrowseUser[];
}

export interface MemoryBrowseTree {
  stats: {
    totalFacts: number;
    activeFacts: number;
    staleFacts: number;
    manualFacts: number;
    autoFacts: number;
  };
  groups: MemoryBrowseGroup[];
}

export function assembleMemoryBrowse(
  facts: FactMeta[],
  groupNames: Map<string, string>,
  nicknames: Map<string, string>,
  now = Date.now(),
): MemoryBrowseTree {
  const byGroup = new Map<string, Map<string, FactMeta[]>>();
  let activeFacts = 0;
  let staleFacts = 0;
  let manualFacts = 0;
  let autoFacts = 0;

  for (const fact of facts) {
    if (fact.status === 'active') {
      activeFacts += 1;
    } else if (fact.status === 'stale') {
      staleFacts += 1;
    }
    if (fact.source === 'manual') {
      manualFacts += 1;
    } else {
      autoFacts += 1;
    }

    let users = byGroup.get(fact.groupId);
    if (!users) {
      users = new Map();
      byGroup.set(fact.groupId, users);
    }
    const existing = users.get(fact.userId);
    if (existing) {
      existing.push(fact);
    } else {
      users.set(fact.userId, [fact]);
    }
  }

  const groups: MemoryBrowseGroup[] = [];
  for (const [groupId, users] of byGroup) {
    const userNodes: MemoryBrowseUser[] = [];
    for (const [userId, userFacts] of users) {
      const isGroupMemory = userId === GROUP_MEMORY_USER_ID;
      const nickname = isGroupMemory ? undefined : nicknames.get(memorySubjectKey(groupId, userId));
      const sorted = [...userFacts].sort(compareFacts);
      userNodes.push({
        userId,
        ...(nickname ? { nickname } : {}),
        isGroupMemory,
        manualText: '',
        ...countFacts(sorted),
        facts: sorted.map((fact) => toBrowseFact(fact, now)),
      });
    }
    userNodes.sort(compareUsers);
    const flat = userNodes.flatMap((user) => user.facts);
    const groupName = groupNames.get(groupId);
    groups.push({
      groupId,
      ...(groupName ? { groupName } : {}),
      ...countBrowseFacts(flat),
      userCount: userNodes.length,
      users: userNodes,
    });
  }

  groups.sort((a, b) => {
    if (b.totalFacts !== a.totalFacts) {
      return b.totalFacts - a.totalFacts;
    }
    return (a.groupName ?? a.groupId).localeCompare(b.groupName ?? b.groupId, 'zh-CN');
  });

  return {
    stats: {
      totalFacts: facts.length,
      activeFacts,
      staleFacts,
      manualFacts,
      autoFacts,
    },
    groups,
  };
}

function toBrowseFact(fact: FactMeta, now: number): MemoryBrowseFact {
  return {
    factHash: fact.factHash,
    scope: fact.scope,
    source: fact.source,
    status: fact.status,
    content: fact.normalizedContent,
    reinforceCount: fact.reinforceCount,
    hitCount: fact.hitCount,
    firstSeen: fact.firstSeen,
    lastReinforced: fact.lastReinforced,
    ...(fact.staleSince !== undefined && fact.staleSince !== null ? { staleSince: fact.staleSince } : {}),
    ageDays: Math.round((now - fact.lastReinforced) / 86_400_000),
  };
}

function countFacts(
  facts: FactMeta[],
): Pick<MemoryBrowseUser, 'totalFacts' | 'activeFacts' | 'staleFacts' | 'manualFacts' | 'autoFacts'> {
  return countBrowseFacts(
    facts.map((fact) => ({
      status: fact.status,
      source: fact.source,
    })),
  );
}

function countBrowseFacts(
  facts: Array<{ status: string; source: string }>,
): Pick<MemoryBrowseUser, 'totalFacts' | 'activeFacts' | 'staleFacts' | 'manualFacts' | 'autoFacts'> {
  let activeFacts = 0;
  let staleFacts = 0;
  let manualFacts = 0;
  let autoFacts = 0;
  for (const fact of facts) {
    if (fact.status === 'active') {
      activeFacts += 1;
    } else if (fact.status === 'stale') {
      staleFacts += 1;
    }
    if (fact.source === 'manual') {
      manualFacts += 1;
    } else {
      autoFacts += 1;
    }
  }
  return {
    totalFacts: facts.length,
    activeFacts,
    staleFacts,
    manualFacts,
    autoFacts,
  };
}

function compareFacts(a: FactMeta, b: FactMeta): number {
  if (a.status !== b.status) {
    return a.status === 'active' ? -1 : 1;
  }
  return b.lastReinforced - a.lastReinforced;
}

/**
 * Attach on-disk manual.txt onto the fact tree. A file with no indexed facts
 * still becomes a slot, because the file is the manual memory.
 */
export function mergeManualDocuments(
  tree: MemoryBrowseTree,
  docs: ManualDocument[],
  groupNames: Map<string, string>,
  nicknames: Map<string, string>,
): MemoryBrowseTree {
  const groups = tree.groups.map((group) => ({
    ...group,
    users: group.users.map((user) => ({ ...user })),
  }));
  const byGroup = new Map(groups.map((group) => [group.groupId, group]));

  for (const doc of docs) {
    const content = doc.content.trim();
    if (!content) {
      continue;
    }
    let group = byGroup.get(doc.groupId);
    if (!group) {
      const groupName = groupNames.get(doc.groupId);
      group = {
        groupId: doc.groupId,
        ...(groupName ? { groupName } : {}),
        totalFacts: 0,
        activeFacts: 0,
        staleFacts: 0,
        manualFacts: 0,
        autoFacts: 0,
        userCount: 0,
        users: [],
      };
      groups.push(group);
      byGroup.set(doc.groupId, group);
    }
    const isGroupMemory = doc.userId === GROUP_MEMORY_USER_ID;
    let user = group.users.find((candidate) => candidate.userId === doc.userId);
    if (!user) {
      const nickname = isGroupMemory ? undefined : nicknames.get(memorySubjectKey(doc.groupId, doc.userId));
      user = {
        userId: doc.userId,
        ...(nickname ? { nickname } : {}),
        isGroupMemory,
        manualText: '',
        totalFacts: 0,
        activeFacts: 0,
        staleFacts: 0,
        manualFacts: 0,
        autoFacts: 0,
        facts: [],
      };
      group.users.push(user);
    }
    user.manualText = content;
    group.users.sort(compareUsers);
    group.userCount = group.users.length;
  }

  groups.sort((a, b) => {
    if (b.totalFacts !== a.totalFacts) {
      return b.totalFacts - a.totalFacts;
    }
    return (a.groupName ?? a.groupId).localeCompare(b.groupName ?? b.groupId, 'zh-CN');
  });

  return { ...tree, groups };
}

function compareUsers(a: MemoryBrowseUser, b: MemoryBrowseUser): number {
  if (a.isGroupMemory !== b.isGroupMemory) {
    return a.isGroupMemory ? -1 : 1;
  }
  const aName = a.nickname ?? a.userId;
  const bName = b.nickname ?? b.userId;
  return aName.localeCompare(bName, 'zh-CN');
}

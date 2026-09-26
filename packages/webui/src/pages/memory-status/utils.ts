import type { MemoryBrowseGroup, MemoryBrowseUser, MemoryFactEntry } from '../../types';

export type MemoryStatusFilter = 'all' | 'active' | 'stale';
export type MemorySourceFilter = 'all' | 'manual' | 'llm_extract';

/** Same order the memory files use for core scopes. Unknown scopes sort after these. */
const CORE_SCOPE_ORDER = [
  'identity',
  'preference',
  'opinion',
  'relationship',
  'behavior',
  'instruction',
  'topic',
  'rule',
  'event',
  'context',
];

export const SCOPE_GLOSS: Record<string, string> = {
  identity: '基本属性',
  preference: '偏好',
  opinion: '观点',
  relationship: '关系',
  behavior: '习惯',
  instruction: '对 bot 的要求',
  topic: '主题',
  rule: '群规',
  event: '事件',
  context: '背景',
};

export interface ScopeNode {
  key: string;
  label: string;
  gloss?: string;
  facts: MemoryFactEntry[];
  children: ScopeNode[];
}

export function formatMemoryDate(ts: number): string {
  if (!ts) {
    return '-';
  }
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatMemoryRecency(days: number): string {
  if (days < 1) {
    return '今天';
  }
  if (days < 30) {
    return `${days} 天前`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)} 个月前`;
  }
  return `${(days / 365).toFixed(1)} 年前`;
}

export function userKey(groupId: string, userId: string): string {
  return `${groupId}\0${userId}`;
}

export interface MemoryDocumentSection {
  scope: string;
  content: string;
}

/** Split a memory file into the `[scope]` sections it is stored as. */
export function parseMemoryDocument(text: string): MemoryDocumentSection[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const sections: MemoryDocumentSection[] = [];
  const sectionRegex = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\[|\s*$)/g;
  for (const match of trimmed.matchAll(sectionRegex)) {
    const content = match[2].trim();
    if (!content) {
      continue;
    }
    sections.push({ scope: match[1].trim(), content });
  }
  if (sections.length === 0) {
    return [{ scope: '', content: trimmed }];
  }
  return sections;
}

export function filterFacts(
  facts: MemoryFactEntry[],
  query: string,
  status: MemoryStatusFilter,
  source: MemorySourceFilter,
): MemoryFactEntry[] {
  const needle = query.trim().toLowerCase();
  return facts.filter((fact) => {
    if (status !== 'all' && fact.status !== status) {
      return false;
    }
    if (source !== 'all' && fact.source !== source) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return fact.scope.toLowerCase().includes(needle) || fact.content.toLowerCase().includes(needle);
  });
}

export function filterBrowseGroups(
  groups: MemoryBrowseGroup[],
  query: string,
  status: MemoryStatusFilter,
  source: MemorySourceFilter,
): MemoryBrowseGroup[] {
  const needle = query.trim().toLowerCase();
  const filtered: MemoryBrowseGroup[] = [];
  for (const group of groups) {
    const users: MemoryBrowseUser[] = [];
    for (const user of group.users) {
      const facts = user.facts.filter((fact) => factVisible(group, user, fact, needle, status, source));
      if (facts.length === 0) {
        continue;
      }
      users.push({ ...user, ...recount(facts), facts });
    }
    if (users.length === 0) {
      continue;
    }
    const flat = users.flatMap((user) => user.facts);
    filtered.push({ ...group, ...recount(flat), userCount: users.length, users });
  }
  return filtered;
}

export function countPeople(group: MemoryBrowseGroup): number {
  return group.users.filter((user) => !user.isGroupMemory).length;
}

export function groupMemoryFacts(group: MemoryBrowseGroup): number {
  return group.users.find((user) => user.isGroupMemory)?.totalFacts ?? 0;
}

export function buildScopeTree(facts: MemoryFactEntry[]): ScopeNode[] {
  const cores = new Map<string, { facts: MemoryFactEntry[]; subs: Map<string, MemoryFactEntry[]> }>();
  for (const fact of facts) {
    const { core, subtag } = splitScope(fact.scope);
    let bucket = cores.get(core);
    if (!bucket) {
      bucket = { facts: [], subs: new Map() };
      cores.set(core, bucket);
    }
    if (subtag) {
      const list = bucket.subs.get(subtag);
      if (list) {
        list.push(fact);
      } else {
        bucket.subs.set(subtag, [fact]);
      }
    } else {
      bucket.facts.push(fact);
    }
  }

  const nodes: ScopeNode[] = [];
  for (const [core, bucket] of cores) {
    const children = [...bucket.subs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
      .map(([subtag, subFacts]) => ({
        key: `${core}:${subtag}`,
        label: subtag,
        facts: subFacts,
        children: [],
      }));
    nodes.push({
      key: core,
      label: core,
      ...(SCOPE_GLOSS[core] ? { gloss: SCOPE_GLOSS[core] } : {}),
      facts: bucket.facts,
      children,
    });
  }
  nodes.sort((a, b) => compareScopeLabel(a.label, b.label));
  return nodes;
}

export function collectScopeKeys(nodes: ScopeNode[]): string[] {
  const keys: string[] = [];
  const walk = (node: ScopeNode) => {
    keys.push(node.key);
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const node of nodes) {
    walk(node);
  }
  return keys;
}

export function scopeFactCount(node: ScopeNode): number {
  let count = node.facts.length;
  for (const child of node.children) {
    count += scopeFactCount(child);
  }
  return count;
}

function factVisible(
  group: MemoryBrowseGroup,
  user: MemoryBrowseUser,
  fact: MemoryFactEntry,
  needle: string,
  status: MemoryStatusFilter,
  source: MemorySourceFilter,
): boolean {
  if (status !== 'all' && fact.status !== status) {
    return false;
  }
  if (source !== 'all' && fact.source !== source) {
    return false;
  }
  if (!needle) {
    return true;
  }
  const fields = [
    group.groupId,
    group.groupName,
    user.userId,
    user.nickname,
    user.isGroupMemory ? '本群记忆' : undefined,
    fact.scope,
    fact.content,
  ];
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

function recount(
  facts: MemoryFactEntry[],
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
  return { totalFacts: facts.length, activeFacts, staleFacts, manualFacts, autoFacts };
}

export function splitScope(scope: string): { core: string; subtag?: string } {
  const trimmed = scope.trim();
  if (!trimmed) {
    return { core: '未分类' };
  }
  const index = trimmed.indexOf(':');
  if (index === -1) {
    return { core: trimmed };
  }
  const core = trimmed.slice(0, index).trim() || '未分类';
  const subtag = trimmed.slice(index + 1).trim();
  return subtag ? { core, subtag } : { core };
}

function compareScopeLabel(a: string, b: string): number {
  const aIndex = CORE_SCOPE_ORDER.indexOf(a);
  const bIndex = CORE_SCOPE_ORDER.indexOf(b);
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) {
      return 1;
    }
    if (bIndex === -1) {
      return -1;
    }
    return aIndex - bIndex;
  }
  return a.localeCompare(b, 'zh-CN');
}

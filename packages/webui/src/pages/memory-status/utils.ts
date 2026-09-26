import type { MemoryFactEntry, MemoryFactStatus } from '../../types';

export type MemoryStatusFilter = 'all' | MemoryFactStatus;
export type MemoryLayerFilter = 'all' | 'manual' | 'auto';

export const STATUS_LABEL: Record<MemoryFactStatus, string> = {
  active: '有效',
  superseded: '已取代',
  retired: '已淘汰',
};

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

export function filterFacts(facts: MemoryFactEntry[], query: string, status: MemoryStatusFilter): MemoryFactEntry[] {
  const needle = query.trim().toLowerCase();
  return facts.filter((fact) => {
    if (status !== 'all' && fact.status !== status) {
      return false;
    }
    return !needle || fact.scope.toLowerCase().includes(needle) || fact.content.toLowerCase().includes(needle);
  });
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

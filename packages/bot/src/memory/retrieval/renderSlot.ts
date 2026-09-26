// One memory slot as the LLM reads it.

import { coreScopeOf } from '../model/scopes';

/** Order core scopes are rendered in; any other scope follows alphabetically. */
const SCOPE_ORDER = [
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

interface ScopedText {
  scope: string;
  content: string;
}

/** Manual facts first (they win conflicts), then automatic ones, each grouped by scope. */
export function renderSlot(manual: ScopedText[], auto: ScopedText[]): string {
  const autoText = renderByScope(auto);
  if (manual.length === 0) {
    return autoText;
  }
  const parts = [`【人工维护，与其他条目冲突时以此为准】\n${renderByScope(manual)}`];
  if (autoText) {
    parts.push(`【自动整理】\n${autoText}`);
  }
  return parts.join('\n\n');
}

export function renderByScope(facts: ScopedText[]): string {
  const byScope = new Map<string, string[]>();
  for (const fact of facts) {
    const list = byScope.get(fact.scope);
    if (list) {
      list.push(fact.content);
    } else {
      byScope.set(fact.scope, [fact.content]);
    }
  }
  return [...byScope.entries()]
    .sort(([a], [b]) => compareScopes(a, b))
    .map(([scope, contents]) => `[${scope}]\n${contents.map((c) => `- ${c}`).join('\n')}`)
    .join('\n\n');
}

function compareScopes(a: string, b: string): number {
  const rank = (scope: string) => {
    const index = SCOPE_ORDER.indexOf(coreScopeOf(scope));
    return index === -1 ? SCOPE_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

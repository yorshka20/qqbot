// Hand-written memory: parsing manual.txt into facts.
//
// A manual file is `[scope]` headers, each followed by one fact per line. Lines are the unit
// on purpose: splitting on punctuation cuts names and versions like `M.C.G.A.` or `Qwen3.5`.
// Lines before the first header belong to `context`.

export interface ManualFact {
  scope: string;
  content: string;
}

const HEADER = /^\[([^\]]+)\]\s*$/;
const BULLET = /^[-*•]\s+/;
const DEFAULT_SCOPE = 'context';

export function parseManualFacts(text: string): ManualFact[] {
  const facts: ManualFact[] = [];
  let scope = DEFAULT_SCOPE;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const header = line.match(HEADER);
    if (header) {
      scope = header[1].trim().toLowerCase() || DEFAULT_SCOPE;
      continue;
    }
    const content = line.replace(BULLET, '').trim();
    if (content) {
      facts.push({ scope, content });
    }
  }
  return facts;
}

export function coreScopeOf(scope: string): string {
  const index = scope.indexOf(':');
  return index === -1 ? scope : scope.slice(0, index);
}

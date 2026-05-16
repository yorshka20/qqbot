export interface SubtextParseResult {
  visible: string;
  subtext?: string;
  replyTags?: string[];
}

const SUBTEXT_RE = /\[SUBTEXT:\s*([^\][]*?)\s*\]/gi;
const META_RE = /\[META:\s*([^\]]*)\]/gi;

export function parseSubtextTags(text: string): SubtextParseResult {
  let subtext: string | undefined;
  let replyTags: string[] | undefined;

  // Extract SUBTEXT (last one wins if multiple — contract says 0~1)
  for (const m of text.matchAll(SUBTEXT_RE)) {
    const captured = m[1].trim();
    if (captured) subtext = captured;
  }

  // Extract META tags
  for (const m of text.matchAll(META_RE)) {
    const items = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length > 0) {
      if (!replyTags) replyTags = [];
      replyTags.push(...items);
    }
  }

  const visible = text.replace(SUBTEXT_RE, '').replace(META_RE, '').replace(/\s+$/, '');

  const result: SubtextParseResult = { visible };
  if (subtext !== undefined) result.subtext = subtext;
  if (replyTags !== undefined) result.replyTags = replyTags;

  return result;
}

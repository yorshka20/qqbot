import type { ParsedTag } from './types';

const DEFAULT_EMOTION = 'neutral';
const DEFAULT_ACTION = 'idle';
const DEFAULT_INTENSITY = 0.5;

// Overall tag: [LIVE2D: ...], case-insensitive, lenient whitespace
const TAG_RE = /\[LIVE2D:\s*([^\]]*)\]/gi;
// Internal key=value pairs: scan pair by pair to support field reordering
const FIELD_RE = /(\w+)\s*=\s*([^,\]\s]+)/g;

export function parseLive2DTags(text: string): ParsedTag[] {
  const out: ParsedTag[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const inner = m[1] ?? '';
    let emotion = DEFAULT_EMOTION;
    let action = DEFAULT_ACTION;
    let intensity = DEFAULT_INTENSITY;
    for (const f of inner.matchAll(FIELD_RE)) {
      const key = f[1].toLowerCase();
      const val = f[2];
      if (key === 'emotion') emotion = val.toLowerCase();
      else if (key === 'action') action = val.toLowerCase();
      else if (key === 'intensity') {
        const n = Number.parseFloat(val);
        if (Number.isFinite(n)) intensity = Math.min(1, Math.max(0, n));
      }
      // Unknown key, silently skip
    }
    out.push({ emotion, action, intensity });
  }
  return out;
}

export function stripLive2DTags(text: string): string {
  return text
    .replace(TAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

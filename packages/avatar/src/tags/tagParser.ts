import type { GazeTarget, LegacyLive2DTag, ParsedTag } from './types';

const DEFAULT_EMOTION = 'neutral';
const DEFAULT_ACTION = 'idle';
const DEFAULT_INTENSITY = 0.5;

const LEGACY_TAG_RE = /\[LIVE2D:\s*([^\]]*)\]/gi;
const RICH_TAG_RE = /\[([AEGHaegh]):\s*([^\]]+?)\s*\]/g;
const LEGACY_FIELD_RE = /(\w+)\s*=\s*([^,\]\s]+)/g;
const NAME_RE = /^([a-z][a-z0-9_]*)$/i;
const NAME_AT_INTENSITY_RE = /^([a-z][a-z0-9_]*)@([0-9]*\.?[0-9]+)$/i;
const GAZE_POINT_RE = /^(-?[0-9]*\.?[0-9]+)\s*,\s*(-?[0-9]*\.?[0-9]+)$/;

const NAMED_GAZE_TARGETS = new Set(['camera', 'left', 'right', 'up', 'down', 'center']);

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function parseActionPayload(payload: string, defaultIntensity: number): { name: string; intensity: number } | null {
  const nameMatch = NAME_RE.exec(payload);
  if (nameMatch) {
    return { name: nameMatch[1].toLowerCase(), intensity: defaultIntensity };
  }
  const nameAtMatch = NAME_AT_INTENSITY_RE.exec(payload);
  if (nameAtMatch) {
    const n = Number.parseFloat(nameAtMatch[2]);
    if (Number.isFinite(n)) {
      return { name: nameAtMatch[1].toLowerCase(), intensity: clamp(n, 0, 1) };
    }
  }
  return null;
}

function parseGazeTarget(payload: string): GazeTarget | null {
  const lower = payload.toLowerCase().trim();
  if (NAMED_GAZE_TARGETS.has(lower)) {
    return { type: 'named', name: lower as 'camera' | 'left' | 'right' | 'up' | 'down' | 'center' };
  }
  if (lower === 'clear') {
    return { type: 'clear' };
  }
  const pointMatch = GAZE_POINT_RE.exec(lower);
  if (pointMatch) {
    const x = Number.parseFloat(pointMatch[1]);
    const y = Number.parseFloat(pointMatch[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { type: 'point', x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    }
  }
  return null;
}

function isValidRichTagPayload(letter: string, payload: string): boolean {
  const l = letter.toLowerCase();
  if (l === 'a' || l === 'e') {
    return parseActionPayload(payload, 1.0) !== null;
  }
  if (l === 'g') {
    return parseGazeTarget(payload) !== null;
  }
  if (l === 'h') {
    const lower = payload.toLowerCase().trim();
    return lower === 'brief' || lower === 'short' || lower === 'long';
  }
  return false;
}

export function parseRichTags(text: string): ParsedTag[] {
  // Collect rich tag matches
  const richMatches: Array<{ index: number; end: number; letter: string; payload: string }> = [];
  for (const m of text.matchAll(RICH_TAG_RE)) {
    richMatches.push({
      index: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      letter: m[1],
      payload: m[2],
    });
  }

  // Collect legacy tag matches
  const legacyMatches: Array<{ index: number; end: number; inner: string }> = [];
  for (const m of text.matchAll(LEGACY_TAG_RE)) {
    legacyMatches.push({
      index: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      inner: m[1] ?? '',
    });
  }

  // Merge and sort by index
  type RichEntry = { kind: 'rich'; index: number; letter: string; payload: string };
  type LegacyEntry = { kind: 'legacy'; index: number; inner: string };
  const entries: Array<RichEntry | LegacyEntry> = [
    ...richMatches.map((m) => ({ kind: 'rich' as const, index: m.index, letter: m.letter, payload: m.payload })),
    ...legacyMatches.map((m) => ({ kind: 'legacy' as const, index: m.index, inner: m.inner })),
  ];
  entries.sort((a, b) => a.index - b.index);

  const out: ParsedTag[] = [];

  for (const entry of entries) {
    if (entry.kind === 'rich') {
      const l = entry.letter.toLowerCase();

      if (l === 'a') {
        const parsed = parseActionPayload(entry.payload, 1.0);
        if (parsed) {
          out.push({ kind: 'action', action: parsed.name, emotion: 'neutral', intensity: parsed.intensity });
        }
      } else if (l === 'e') {
        const parsed = parseActionPayload(entry.payload, 0.8);
        if (parsed) {
          out.push({ kind: 'emotion', emotion: parsed.name, intensity: parsed.intensity });
        }
      } else if (l === 'g') {
        const target = parseGazeTarget(entry.payload);
        if (target) {
          out.push({ kind: 'gaze', target });
        }
      } else if (l === 'h') {
        const lower = entry.payload.toLowerCase().trim();
        if (lower === 'brief' || lower === 'short' || lower === 'long') {
          out.push({ kind: 'hold', dur: lower });
        }
      }
    } else {
      // Legacy [LIVE2D: ...] tag
      const inner = entry.inner;
      let emotion = DEFAULT_EMOTION;
      let action = DEFAULT_ACTION;
      let intensity = DEFAULT_INTENSITY;

      for (const f of inner.matchAll(LEGACY_FIELD_RE)) {
        const key = f[1].toLowerCase();
        const val = f[2];
        if (key === 'emotion') emotion = val.toLowerCase();
        else if (key === 'action') action = val.toLowerCase();
        else if (key === 'intensity') {
          const n = Number.parseFloat(val);
          if (Number.isFinite(n)) intensity = clamp(n, 0, 1);
        }
      }

      out.push({ kind: 'action', action, emotion, intensity });

      // Future config flag `compiler.legacyEmotionPersist` may gate this —
      // not implemented this ticket, add only if users report regressions.
      if (emotion !== 'neutral') {
        out.push({ kind: 'emotion', emotion, intensity: 0.6 });
      }
    }
  }

  return out;
}

export function parseLive2DTags(text: string): LegacyLive2DTag[] {
  const out: LegacyLive2DTag[] = [];
  for (const t of parseRichTags(text)) {
    if (t.kind === 'action') {
      out.push({ action: t.action, emotion: t.emotion, intensity: t.intensity });
    }
  }
  return out;
}

export function stripLive2DTags(text: string): string {
  // Collect valid rich tag ranges
  const ranges: Array<[number, number]> = [];

  for (const m of text.matchAll(RICH_TAG_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (isValidRichTagPayload(m[1], m[2])) {
      ranges.push([start, end]);
    }
  }

  // Collect legacy tag ranges (always strip)
  for (const m of text.matchAll(LEGACY_TAG_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    ranges.push([start, end]);
  }

  // Sort ranges by start position
  ranges.sort((a, b) => a[0] - b[0]);

  // Splice out ranges
  let result = '';
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) {
      result += text.slice(pos, start);
    }
    pos = end;
  }
  result += text.slice(pos);

  return result
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

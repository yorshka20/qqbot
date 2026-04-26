import { parseNamedHeadLookTarget } from './headLook';
import type { FaceTarget, GazeTarget, LegacyLive2DTag, ParsedTag, WalkMotion, WalkToTarget } from './types';

const DEFAULT_EMOTION = 'neutral';
const DEFAULT_ACTION = 'idle';
const DEFAULT_INTENSITY = 0.5;

const LEGACY_TAG_RE = /\[LIVE2D:\s*([^\]]*)\]/gi;
const RICH_TAG_RE = /\[([AEGHWKaeghwk]):\s*([^\]]+?)\s*\]/g;
const LEGACY_FIELD_RE = /(\w+)\s*=\s*([^,\]\s]+)/g;
const NAME_RE = /^([a-z][a-z0-9_]*)$/i;
const NAME_AT_INTENSITY_RE = /^([a-z][a-z0-9_]*)@([0-9]*\.?[0-9]+)$/i;
const GAZE_POINT_RE = /^(-?[0-9]*\.?[0-9]+)\s*,\s*(-?[0-9]*\.?[0-9]+)$/;
const HEAD_LOOK_PAIR_RE = /^(-?[0-9]*\.?[0-9]+)\s*,\s*(-?[0-9]*\.?[0-9]+)$/;

const NAMED_GAZE_TARGETS = new Set(['camera', 'left', 'right', 'up', 'down', 'center']);
const WALK_TO_TARGETS = new Set<WalkToTarget>(['camera', 'center', 'back']);
const WALK_FACE_TARGETS = new Set<FaceTarget>(['camera', 'back', 'left', 'right']);

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

function parseWalkPayload(payload: string): WalkMotion | null {
  const parts = payload
    .trim()
    .split(':')
    .map((p) => p.trim());
  if (parts.length === 0 || parts[0] === '') return null;
  const name = parts[0].toLowerCase();
  switch (name) {
    case 'forward':
    case 'back':
    case 'strafe': {
      if (parts.length !== 2) return null;
      const m = Number.parseFloat(parts[1]);
      if (!Number.isFinite(m)) return null;
      if (name === 'back') return { type: 'forward', meters: -m };
      if (name === 'strafe') return { type: 'strafe', meters: m };
      return { type: 'forward', meters: m };
    }
    case 'turn': {
      if (parts.length !== 2) return null;
      const deg = Number.parseFloat(parts[1]);
      if (!Number.isFinite(deg)) return null;
      return { type: 'turn', degrees: deg };
    }
    case 'orbit': {
      if (parts.length < 2 || parts.length > 3) return null;
      const deg = Number.parseFloat(parts[1]);
      if (!Number.isFinite(deg)) return null;
      let radius: number | undefined;
      if (parts.length === 3) {
        radius = Number.parseFloat(parts[2]);
        if (!Number.isFinite(radius)) return null;
      }
      return radius === undefined ? { type: 'orbit', degrees: deg } : { type: 'orbit', degrees: deg, radius };
    }
    case 'to': {
      if (parts.length !== 2) return null;
      const target = parts[1].toLowerCase() as WalkToTarget;
      if (!WALK_TO_TARGETS.has(target)) return null;
      return { type: 'to', target };
    }
    case 'face': {
      if (parts.length !== 2) return null;
      const target = parts[1].toLowerCase() as FaceTarget;
      if (!WALK_FACE_TARGETS.has(target)) return null;
      return { type: 'face', target };
    }
    case 'stop':
      return parts.length === 1 ? { type: 'stop' } : null;
    default:
      return null;
  }
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
  if (l === 'w') {
    return parseWalkPayload(payload) !== null;
  }
  if (l === 'k') {
    const lower = payload.toLowerCase().trim();
    const named = parseNamedHeadLookTarget(lower);
    if (named !== undefined) return true;
    const m = HEAD_LOOK_PAIR_RE.exec(lower);
    if (m) {
      return Number.isFinite(Number(m[1])) && Number.isFinite(Number(m[2]));
    }
    return false;
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
      } else if (l === 'w') {
        const motion = parseWalkPayload(entry.payload);
        if (motion) {
          out.push({ kind: 'walk', motion });
        }
      } else if (l === 'k') {
        const lower = entry.payload.toLowerCase().trim();
        const named = parseNamedHeadLookTarget(lower);
        if (named !== undefined) {
          out.push({ kind: 'headLook', target: named });
        } else {
          const m = HEAD_LOOK_PAIR_RE.exec(lower);
          if (m) {
            const yaw = Number(m[1]);
            const pitch = Number(m[2]);
            if (Number.isFinite(yaw) && Number.isFinite(pitch)) {
              out.push({ kind: 'headLook', target: { yaw, pitch } });
            }
          }
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

export interface IdleClipKeyframe {
  time: number;
  value: number;
}

export interface IdleClipQuatKeyframe {
  time: number;
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface IdleClipScalarTrack {
  kind?: 'scalar';
  channel: string;
  easing?: string;
  keyframes: IdleClipKeyframe[];
}

export interface IdleClipQuatTrack {
  kind: 'quat';
  channel: string;
  keyframes: IdleClipQuatKeyframe[];
}

export type IdleClipTrack = IdleClipScalarTrack | IdleClipQuatTrack;

export interface IdleClip {
  id: string;
  duration: number;
  tracks: IdleClipTrack[];
}

/**
 * Type guard for IdleClip. Accepts both v1 (scalar-only) and v2 (with quat
 * tracks) JSON. For quat tracks, validates unit-quaternion norm within 1e-3.
 */
export function isIdleClip(x: unknown): x is IdleClip {
  if (typeof x !== 'object' || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (typeof obj['id'] !== 'string') return false;
  if (typeof obj['duration'] !== 'number') return false;
  if (!Array.isArray(obj['tracks'])) return false;
  for (const track of obj['tracks']) {
    if (typeof track !== 'object' || track === null) return false;
    const t = track as Record<string, unknown>;
    if (typeof t['channel'] !== 'string') return false;
    if (!Array.isArray(t['keyframes'])) return false;

    if (t['kind'] === 'quat') {
      // v2 quat track — validate {time, x, y, z, w} keyframes and unit norm
      for (const kf of t['keyframes']) {
        if (typeof kf !== 'object' || kf === null) return false;
        const k = kf as Record<string, unknown>;
        if (typeof k['time'] !== 'number') return false;
        if (typeof k['x'] !== 'number') return false;
        if (typeof k['y'] !== 'number') return false;
        if (typeof k['z'] !== 'number') return false;
        if (typeof k['w'] !== 'number') return false;
        // Reject non-unit quaternions (norm must be within 1e-3 of 1.0)
        const norm = Math.sqrt(
          (k['x'] as number) ** 2 +
          (k['y'] as number) ** 2 +
          (k['z'] as number) ** 2 +
          (k['w'] as number) ** 2,
        );
        if (Math.abs(norm - 1) > 1e-3) return false;
      }
    } else {
      // v1 scalar track (backward compatible) — validate {time, value} keyframes
      for (const kf of t['keyframes']) {
        if (typeof kf !== 'object' || kf === null) return false;
        const k = kf as Record<string, unknown>;
        if (typeof k['time'] !== 'number') return false;
        if (typeof k['value'] !== 'number') return false;
      }
    }
  }
  return true;
}

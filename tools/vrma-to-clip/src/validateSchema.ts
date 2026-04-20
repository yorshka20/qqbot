export interface IdleClipKeyframe {
  time: number;
  value: number;
}

export interface IdleClipTrack {
  channel: string;
  easing?: string;
  keyframes: IdleClipKeyframe[];
}

export interface IdleClip {
  id: string;
  duration: number;
  tracks: IdleClipTrack[];
}

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
    for (const kf of t['keyframes']) {
      if (typeof kf !== 'object' || kf === null) return false;
      const k = kf as Record<string, unknown>;
      if (typeof k['time'] !== 'number') return false;
      if (typeof k['value'] !== 'number') return false;
    }
  }
  return true;
}

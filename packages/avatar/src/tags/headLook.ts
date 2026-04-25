import type { HeadLookTarget } from '../compiler/layers/HeadLookLayer';

// duplicates NAMED_GLANCE_TARGETS in packages/bot/src/mind/wander/intents.ts — keep in sync until cross-package import path lands
export const NAMED_HEAD_LOOK_TARGETS = {
  camera: { yaw: 0, pitch: 0 },
  center: { yaw: 0, pitch: 0 },
  left: { yaw: -15, pitch: 0 },
  right: { yaw: 15, pitch: 0 },
  up: { yaw: 0, pitch: -10 },
  down: { yaw: 0, pitch: 10 },
} as const satisfies Record<string, HeadLookTarget>;

/** Returns null for "clear", target for named, undefined for unknown name. */
export function parseNamedHeadLookTarget(name: string): HeadLookTarget | null | undefined {
  if (name === 'clear') return null;
  return NAMED_HEAD_LOOK_TARGETS[name as keyof typeof NAMED_HEAD_LOOK_TARGETS];
}

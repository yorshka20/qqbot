/**
 * Channel prefixes that AvatarService.enqueueEmotion will pass through.
 *
 * Rationale: the action-map entry for an emotion name (e.g. `thinking`) may
 * include non-face channels like `head.yaw` so the `[A:thinking]` action
 * can tilt the head. When that same entry is consumed via `[E:thinking]`
 * (emotion persistence), we want only the facial channels so the body
 * pose is left to other layers.
 */
export const EMOTION_CHANNEL_PREFIXES = ['mouth', 'eye.smile', 'brow', 'cheek'] as const;

export function isEmotionChannel(channel: string): boolean {
  return EMOTION_CHANNEL_PREFIXES.some((p) => channel === p || channel.startsWith(`${p}.`));
}

/**
 * Channel groups — semantic categories over the union of Cubism and VRM
 * channel namespaces. Used by external consumers (notably the mind system's
 * `PersonaModulation.perChannelGroupScale`) to apply group-level
 * multipliers / filters without knowing individual channel ids.
 *
 * Groups are **disjoint**: every known channel maps to exactly one group,
 * or `undefined` when the channel does not fit a semantic bucket (unknown
 * custom channels, `vrm.expression.*` pattern entries, etc.).
 *
 * The taxonomy is deliberately coarse — head / body / arm / leg / face
 * (with face sub-groups split into eye / mouth / brow / cheek for finer
 * control), plus dedicated buckets for root locomotion and breath. This
 * matches the cadence at which personality traits typically scale
 * expression (e.g. "introvert → lower arm amplitude", not "introvert →
 * lower arm.shoulder.y amplitude").
 */

import { CHANNELS } from './registry';
import { VRM_CHANNELS } from './vrm-registry';

/**
 * Canonical channel group ids. Disjoint — any channel maps to at most one.
 */
export const CHANNEL_GROUP_IDS = [
  'head', // head + neck rotation
  'body', // torso (hips / spine / chest)
  'arm', // shoulder / upper arm / lower arm / hand, both sides
  'leg', // upper leg / lower leg / foot, both sides (VRM only)
  'face', // umbrella for eye + mouth + brow + cheek (Cubism face)
  'eye', // eye openness + ball + smile (sub-group of face)
  'mouth', // mouth open + smile (sub-group of face)
  'brow', // brow form (sub-group of face)
  'cheek', // cheek puff (sub-group of face)
  'breath', // breath / chest-rise
  'root', // vrm.root.* locomotion
  'expression', // vrm.expression.* pattern-based blendshapes
] as const;

export type ChannelGroup = (typeof CHANNEL_GROUP_IDS)[number];

/**
 * Prefix-based classification for VRM humanoid bones. Matched against
 * `vrm.<bone>.<axis>` channel ids.
 */
const VRM_ARM_BONES = new Set([
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
]);
const VRM_LEG_BONES = new Set([
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
]);
const VRM_HEAD_BONES = new Set(['head', 'neck']);
const VRM_BODY_BONES = new Set(['hips', 'spine', 'chest', 'upperChest']);

/**
 * Classify a channel id into exactly one group, or `undefined` when the
 * channel does not match any known bucket.
 *
 * The classifier accepts unknown / custom channel ids gracefully — callers
 * should treat `undefined` as "ungrouped" and fall back to the global
 * modulation value.
 */
export function getChannelGroup(channelId: string): ChannelGroup | undefined {
  // VRM channels — parse `vrm.<bone>.<axis>` or `vrm.root.*` / `vrm.expression.*`.
  if (channelId.startsWith('vrm.')) {
    const rest = channelId.slice(4);
    const firstDot = rest.indexOf('.');
    const head = firstDot === -1 ? rest : rest.slice(0, firstDot);
    if (head === 'root') return 'root';
    if (head === 'expression') return 'expression';
    if (VRM_HEAD_BONES.has(head)) return 'head';
    if (VRM_BODY_BONES.has(head)) return 'body';
    if (VRM_ARM_BONES.has(head)) return 'arm';
    if (VRM_LEG_BONES.has(head)) return 'leg';
    return undefined;
  }

  // Cubism channels — prefix on the first dot.
  if (channelId === 'breath') return 'breath';
  if (channelId === 'brow' || channelId.startsWith('brow.')) return 'brow';
  if (channelId.startsWith('head.')) return 'head';
  if (channelId.startsWith('body.')) return 'body';
  if (channelId.startsWith('arm.')) return 'arm';
  if (channelId.startsWith('eye.')) return 'eye';
  if (channelId.startsWith('mouth.')) return 'mouth';
  if (channelId.startsWith('cheek.')) return 'cheek';
  return undefined;
}

/**
 * Precomputed group → channel-id lists across the union of Cubism + VRM
 * registries. Useful for UI / debug surfaces that need to enumerate every
 * channel in a group. Channels whose group is `undefined` are omitted.
 *
 * Note: `face` is intentionally left empty — it is an *umbrella* over
 * eye / mouth / brow / cheek and does not directly own channels. Consumers
 * that want "everything facial" should union those four sub-groups.
 */
export const CHANNEL_GROUPS: Readonly<Record<ChannelGroup, readonly string[]>> = (() => {
  const out: Record<ChannelGroup, string[]> = {
    head: [],
    body: [],
    arm: [],
    leg: [],
    face: [],
    eye: [],
    mouth: [],
    brow: [],
    cheek: [],
    breath: [],
    root: [],
    expression: [],
  };
  const all = [...CHANNELS.map((c) => c.id), ...VRM_CHANNELS.map((c) => c.id)];
  for (const id of all) {
    const group = getChannelGroup(id);
    if (group) out[group].push(id);
  }
  return out;
})();

/**
 * Sub-group composition for umbrella groups. `face` covers eye + mouth +
 * brow + cheek. Kept separate so callers can choose coarse ("scale all
 * facial expression") vs fine ("scale only mouth") granularity.
 */
export const CHANNEL_GROUP_CHILDREN: Readonly<Partial<Record<ChannelGroup, readonly ChannelGroup[]>>> = {
  face: ['eye', 'mouth', 'brow', 'cheek'],
};

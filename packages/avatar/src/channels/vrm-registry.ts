import type { ChannelInfo } from './types';

/**
 * VRM-specific channel registry. Mirrors the structure of `CHANNELS`
 * (Live2D/Cubism domain) but targets VRM humanoid bones, expressions, and
 * root motion. Lives in a separate file because the two domains have
 * disjoint naming conventions and disjoint consumers (Cubism renderer vs
 * VRM renderer).
 *
 * Channels produced here are emitted by the AnimationCompiler's clip
 * execution path (from sampled VRMA-derived clips) and consumed by the
 * renderer's VRM adapter. VTSDriver ignores them automatically since none
 * have a `vtsParam`.
 */

const ROTATION_RANGE: [number, number] = [-3.14, 3.14]; // radians
const ROOT_TRANSLATE_RANGE: [number, number] = [-3, 3]; // meters

/**
 * Humanoid bones drivable per axis. Names match VRM 1.0 humanoid bone id
 * convention. Extend conservatively — adding a bone here immediately adds
 * 3 channels and widens the VRM adapter's surface.
 */
const HUMANOID_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
] as const;

const channels: ChannelInfo[] = [];

for (const bone of HUMANOID_BONES) {
  for (const axis of ['x', 'y', 'z'] as const) {
    channels.push({
      id: `vrm.${bone}.${axis}`,
      range: ROTATION_RANGE,
      description: `VRM humanoid ${bone} rotation around ${axis.toUpperCase()} axis, radians`,
    });
  }
}

channels.push(
  { id: 'vrm.root.x', range: ROOT_TRANSLATE_RANGE, description: 'Scene root X translation, meters' },
  { id: 'vrm.root.z', range: ROOT_TRANSLATE_RANGE, description: 'Scene root Z translation, meters' },
  { id: 'vrm.root.rotY', range: ROTATION_RANGE, description: 'Scene root Y rotation (yaw), radians' },
);

/**
 * Note on `vrm.expression.*` — expression channels are pattern-based, not
 * pre-enumerated, because the concrete expression set varies per VRM model
 * (neutral/happy/sad/angry + custom blendshapes). Consumers match the
 * prefix via regex and route to the VRM ExpressionManager.
 */

export const VRM_CHANNELS: readonly ChannelInfo[] = channels;
export const VRM_CHANNEL_BY_ID: ReadonlyMap<string, ChannelInfo> = new Map(channels.map((c) => [c.id, c]));

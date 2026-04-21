/**
 * VRM humanoid rest-pose offsets applied as a per-channel "floor" every tick
 * when no other contribution drives the channel. VRM 1.0 normalized humanoid
 * defines T-pose as identity on every bone, which looks mechanical with arms
 * held horizontally. The constants below push the upper arms down ~69° to
 * approximate a natural A-pose. Authors override per-key in
 * `CompilerConfig.restPose`.
 *
 * Rotation conventions: radians, XYZ-euler axis per `vrm.<bone>.<axis>`
 * channel. Sign follows Three.js right-hand rule on the normalized humanoid
 * (+X right, +Y up, -Z forward). `leftUpperArm.z = -1.2` rotates the arm
 * from world +X (T-pose direction) toward world -Y (down).
 */
export const DEFAULT_VRM_REST_POSE: Record<string, number> = {
  'vrm.leftUpperArm.z': -1.2,
  'vrm.rightUpperArm.z': 1.2,
};

/**
 * Merge user-provided rest pose with defaults. User values override per-key;
 * setting a key to 0 effectively disables that default (channel contributes
 * 0 rather than the built-in offset).
 */
export function mergeRestPose(
  user?: Record<string, number>,
): Record<string, number> {
  if (!user) return { ...DEFAULT_VRM_REST_POSE };
  return { ...DEFAULT_VRM_REST_POSE, ...user };
}

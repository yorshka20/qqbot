import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Public types ─────────────────────────────────────────────────────────────

export type RestPoseEuler = Record<string, { x: number; y: number; z: number }>;
export type RestPoseQuat = Record<string, { x: number; y: number; z: number; w: number }>;
export type RestPose = { euler: RestPoseEuler; quat: RestPoseQuat };

// ── Math ─────────────────────────────────────────────────────────────────────

/**
 * Intrinsic Tait-Bryan XYZ Euler → unit quaternion. Matches three.js
 * `THREE.Euler.set(x, y, z, 'XYZ')` semantics (the rotation order three-vrm
 * uses for humanoid bones).
 *
 * Rx · Ry · Rz (right-to-left composition):
 *   cx = cos(x/2), sx = sin(x/2)
 *   cy = cos(y/2), sy = sin(y/2)
 *   cz = cos(z/2), sz = sin(z/2)
 *   qw = cx*cy*cz - sx*sy*sz
 *   qx = sx*cy*cz + cx*sy*sz
 *   qy = cx*sy*cz - sx*cy*sz
 *   qz = cx*cy*sz + sx*sy*cz
 */
export function eulerToQuat(
  x: number,
  y: number,
  z: number,
  order: 'XYZ' = 'XYZ',
): { x: number; y: number; z: number; w: number } {
  if (order !== 'XYZ') {
    throw new Error(`[restPose] eulerToQuat: unsupported rotation order "${order}". Only "XYZ" is supported.`);
  }

  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);

  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

const DEFAULT_JSON_PATH = path.resolve(__dirname, '../../assets/vrm-rest-pose.json');

/**
 * Load rest pose from packages/avatar/assets/vrm-rest-pose.json (or a custom path).
 * Validates schema + rotation order, derives quat map from euler map.
 * Throws on missing file, malformed JSON, schema mismatch, or unsupported
 * rotation order.
 */
export function loadRestPose(jsonPath?: string): RestPose {
  const filePath = jsonPath ?? DEFAULT_JSON_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`[restPose] cannot read file "${filePath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[restPose] malformed JSON in "${filePath}": ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`[restPose] expected an object in "${filePath}"`);
  }

  const obj = parsed as Record<string, unknown>;

  if (obj['$schema'] !== 'vrm-rest-pose.v1') {
    throw new Error(`[restPose] schema mismatch: expected "vrm-rest-pose.v1", got "${obj['$schema']}"`);
  }

  if (obj['rotationOrder'] !== 'XYZ') {
    throw new Error(`[restPose] unsupported rotationOrder: expected "XYZ", got "${obj['rotationOrder']}"`);
  }

  const euler = obj['euler'] as RestPoseEuler;

  if (typeof euler !== 'object' || euler === null) {
    throw new Error(`[restPose] "euler" field is missing or not an object in "${filePath}"`);
  }

  const quat: RestPoseQuat = {};
  for (const bone of Object.keys(euler)) {
    const e = euler[bone];
    quat[bone] = eulerToQuat(e.x, e.y, e.z);
  }

  return { euler, quat };
}

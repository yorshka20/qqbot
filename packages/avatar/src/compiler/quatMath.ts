/**
 * Quaternion slerp utilities shared across the compiler (clip sampling + the
 * discrete-animation quat path). Scalar-argument signatures avoid allocating
 * wrapper objects in the per-tick hot loop.
 *
 * Both functions expect unit-quaternion inputs and return a unit quaternion.
 * Shortest-arc (flip b when dot < 0) and LERP+renormalise fast path for
 * nearly-parallel quats (dot > 0.9995) are applied uniformly.
 */

const NEARLY_PARALLEL_DOT = 0.9995;

/**
 * Spherical linear interpolation from unit quaternion a to unit quaternion b
 * at t∈[0,1]. Used for clip inter-keyframe sampling and for the clip path's
 * anchor-to-clip blend (so a clip's release tail returns to the idle pose).
 */
export function slerpQuat(
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
  t: number,
): { x: number; y: number; z: number; w: number } {
  if (t <= 0) return { x: ax, y: ay, z: az, w: aw };
  if (t >= 1) return { x: bx, y: by, z: bz, w: bw };

  let dot = ax * bx + ay * by + az * bz + aw * bw;
  let nbx = bx;
  let nby = by;
  let nbz = bz;
  let nbw = bw;
  if (dot < 0) {
    nbx = -bx;
    nby = -by;
    nbz = -bz;
    nbw = -bw;
    dot = -dot;
  }

  if (dot > NEARLY_PARALLEL_DOT) {
    const rx = ax + t * (nbx - ax);
    const ry = ay + t * (nby - ay);
    const rz = az + t * (nbz - az);
    const rw = aw + t * (nbw - aw);
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
    return { x: rx / len, y: ry / len, z: rz / len, w: rw / len };
  }

  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta0 = Math.sin(theta0);
  const sinA = Math.sin((1 - t) * theta0) / sinTheta0;
  const sinB = Math.sin(t * theta0) / sinTheta0;

  return {
    x: sinA * ax + sinB * nbx,
    y: sinA * ay + sinB * nby,
    z: sinA * az + sinB * nbz,
    w: sinA * aw + sinB * nbw,
  };
}

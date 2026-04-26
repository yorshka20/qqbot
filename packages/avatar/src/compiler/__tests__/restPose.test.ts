import { describe, expect, test } from 'bun:test';
import { eulerToQuat, loadRestPose } from '../restPose';

// ── Helpers ──────────────────────────────────────────────────────────────────

function approxEqual(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

function quatApprox(
  q: { x: number; y: number; z: number; w: number },
  expected: { x: number; y: number; z: number; w: number },
  eps: number,
): boolean {
  return (
    approxEqual(q.x, expected.x, eps) &&
    approxEqual(q.y, expected.y, eps) &&
    approxEqual(q.z, expected.z, eps) &&
    approxEqual(q.w, expected.w, eps)
  );
}

// ── eulerToQuat tests ────────────────────────────────────────────────────────

describe('eulerToQuat', () => {
  test('identity: (0,0,0) → {x:0, y:0, z:0, w:1}', () => {
    const q = eulerToQuat(0, 0, 0);
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  test('(PI,0,0) ≈ {x:1, y:0, z:0, w:0}', () => {
    const q = eulerToQuat(Math.PI, 0, 0);
    const eps = 1e-9;
    expect(quatApprox(q, { x: 1, y: 0, z: 0, w: 0 }, eps)).toBe(true);
  });

  test('(0,PI/2,0) ≈ {x:0, y:SQRT1_2, z:0, w:SQRT1_2}', () => {
    const q = eulerToQuat(0, Math.PI / 2, 0);
    const eps = 1e-9;
    expect(
      quatApprox(q, { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, eps),
    ).toBe(true);
  });

  test('(0,0,PI/2) ≈ {x:0, y:0, z:SQRT1_2, w:SQRT1_2}', () => {
    const q = eulerToQuat(0, 0, Math.PI / 2);
    const eps = 1e-9;
    expect(
      quatApprox(q, { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, eps),
    ).toBe(true);
  });

  test('(0.1, 0.2, 0.3) produces a unit quaternion', () => {
    const q = eulerToQuat(0.1, 0.2, 0.3);
    const norm2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
    expect(Math.abs(norm2 - 1)).toBeLessThanOrEqual(1e-12);
  });
});

// ── loadRestPose tests ───────────────────────────────────────────────────────

describe('loadRestPose', () => {
  test('loads real file and returns euler + quat maps with required bones', () => {
    const pose = loadRestPose();
    const requiredBones = [
      'hips',
      'spine',
      'head',
      'leftUpperArm',
      'rightUpperArm',
      'leftFoot',
      'rightFoot',
      'leftHand',
      'rightHand',
    ];
    for (const bone of requiredBones) {
      expect(pose.euler[bone]).toBeDefined();
      expect(pose.quat[bone]).toBeDefined();
    }
  });

  test('quat.hips is consistent with eulerToQuat(euler.hips)', () => {
    const pose = loadRestPose();
    const e = pose.euler['hips'];
    const expected = eulerToQuat(e.x, e.y, e.z);
    const actual = pose.quat['hips'];
    const eps = 1e-12;
    expect(quatApprox(actual, expected, eps)).toBe(true);
  });

  test('throws on nonexistent path', () => {
    expect(() => loadRestPose('/nonexistent/path/vrm-rest-pose.json')).toThrow();
  });
});

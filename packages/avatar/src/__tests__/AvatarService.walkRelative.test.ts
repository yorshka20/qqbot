// Unit tests for AvatarService.walkRelative() — verifies the world-space target
// computation from a known starting pose. Tests prove that the formula
//   targetX = x + forwardM * sin(facing) + strafeM * cos(facing)
//   targetZ = z + forwardM * cos(facing) + strafeM * (-sin(facing))
//   targetFacing = facing + turnRad
// produces the correct absolute walkTo() arguments.

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { AnimationCompiler } from '../compiler/AnimationCompiler';
import type { WalkingLayer } from '../compiler/layers/WalkingLayer';

function testCompiler(service: AvatarService): AnimationCompiler {
  const c = (service as unknown as { compiler: AnimationCompiler | null }).compiler;
  if (!c) throw new Error('expected compiler after initialize()');
  return c;
}

describe('AvatarService.walkRelative — world-space target computation', () => {
  let service: AvatarService;

  beforeEach(async () => {
    service = new AvatarService();
    await service.initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 30, outputFps: 30 },
    });
  });

  afterEach(() => {
    service.stop();
  });

  function walkingOf(s: AvatarService): WalkingLayer {
    return testCompiler(s).getLayer('walking') as WalkingLayer;
  }

  test('facing=0 (north) — forward goes along +Z, strafe goes along +X', () => {
    const layer = walkingOf(service);
    // Starting pose: x=1, z=2, facing=0
    spyOn(layer, 'getPosition').mockReturnValue({ x: 1, z: 2, facing: 0 });
    const walkToSpy = spyOn(layer, 'walkTo').mockReturnValue(Promise.resolve());

    // forward=1.0, strafe=0.5, turn=0
    // targetX = 1 + 1.0*sin(0) + 0.5*cos(0) = 1 + 0 + 0.5 = 1.5
    // targetZ = 2 + 1.0*cos(0) + 0.5*(-sin(0)) = 2 + 1.0 + 0 = 3.0
    // targetFacing = 0 + 0 = 0
    service.walkRelative(1.0, 0.5, 0);

    expect(walkToSpy).toHaveBeenCalledTimes(1);
    const [tx, tz, tf] = walkToSpy.mock.calls[0] as [number, number, number];
    expect(tx).toBeCloseTo(1.5, 9);
    expect(tz).toBeCloseTo(3.0, 9);
    expect(tf).toBeCloseTo(0, 9);
  });

  test('facing=PI/2 (east) — forward goes along +X, strafe goes along -Z', () => {
    const layer = walkingOf(service);
    // Starting pose: x=0, z=0, facing=PI/2
    spyOn(layer, 'getPosition').mockReturnValue({ x: 0, z: 0, facing: Math.PI / 2 });
    const walkToSpy = spyOn(layer, 'walkTo').mockReturnValue(Promise.resolve());

    // forward=1.0, strafe=0.5, turn=PI/4
    // sin(PI/2)=1, cos(PI/2)=0 (approximately)
    // targetX = 0 + 1.0*1 + 0.5*0 = 1.0
    // targetZ = 0 + 1.0*0 + 0.5*(-1) = -0.5
    // targetFacing = PI/2 + PI/4 = 3*PI/4
    service.walkRelative(1.0, 0.5, Math.PI / 4);

    expect(walkToSpy).toHaveBeenCalledTimes(1);
    const [tx, tz, tf] = walkToSpy.mock.calls[0] as [number, number, number];
    expect(tx).toBeCloseTo(1.0, 9);
    expect(tz).toBeCloseTo(-0.5, 9);
    expect(tf).toBeCloseTo((3 * Math.PI) / 4, 9);
  });

  test('pure turn only — no translation, facing delta applied correctly', () => {
    const layer = walkingOf(service);
    spyOn(layer, 'getPosition').mockReturnValue({ x: 2, z: -1, facing: Math.PI });
    const walkToSpy = spyOn(layer, 'walkTo').mockReturnValue(Promise.resolve());

    // forward=0, strafe=0, turn=PI/6
    // targetX = 2 + 0 + 0 = 2
    // targetZ = -1 + 0 + 0 = -1
    // targetFacing = PI + PI/6
    service.walkRelative(0, 0, Math.PI / 6);

    expect(walkToSpy).toHaveBeenCalledTimes(1);
    const [tx, tz, tf] = walkToSpy.mock.calls[0] as [number, number, number];
    expect(tx).toBeCloseTo(2, 9);
    expect(tz).toBeCloseTo(-1, 9);
    expect(tf).toBeCloseTo(Math.PI + Math.PI / 6, 9);
  });

  test('rejects when WalkingLayer is not available (cubism model)', async () => {
    // Override getWalkingLayer to return null
    (service as unknown as { getWalkingLayer: () => null }).getWalkingLayer = () => null;

    await expect(service.walkRelative(1, 0, 0)).rejects.toThrow('[AvatarService] WalkingLayer is not available');
  });
});

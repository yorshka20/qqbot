import 'reflect-metadata';

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { AvatarService } from './AvatarService';

type WalkingLayerStub = {
  id: 'walking';
  walkTo: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  getPosition: ReturnType<typeof mock>;
  walkPromise: Promise<void>;
};

function makeWalkingLayer() {
  const walkPromise = Promise.resolve();
  return {
    id: 'walking' as const,
    walkTo: mock(() => walkPromise),
    stop: mock(() => {}),
    getPosition: mock(() => ({ x: 1.25, z: -0.5, facing: Math.PI / 4 })),
    walkPromise,
  };
}

describe('AvatarService walking facade', () => {
  let service: AvatarService;

  beforeEach(() => {
    service = new AvatarService();
  });

  test('walkTo() delegates to WalkingLayer and returns its promise', async () => {
    const layer = makeWalkingLayer();
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [layer];

    const result = service.walkTo(3, 4, Math.PI);

    expect(result).toBe(layer.walkPromise);
    expect(layer.walkTo).toHaveBeenCalledWith(3, 4, Math.PI);
    await result;
  });

  test('stopWalk() delegates to WalkingLayer.stop()', () => {
    const layer = makeWalkingLayer();
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [layer];

    service.stopWalk();

    expect(layer.stop).toHaveBeenCalledTimes(1);
  });

  test('getCurrentPosition() returns the walking layer position', () => {
    const layer = makeWalkingLayer();
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [layer];

    expect(service.getCurrentPosition()).toEqual({ x: 1.25, z: -0.5, facing: Math.PI / 4 });
  });

  test('missing walking layer falls back cleanly', async () => {
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [];

    await expect(service.walkTo(1, 2, 3)).rejects.toThrow('[AvatarService] WalkingLayer is not available');
    expect(() => service.stopWalk()).not.toThrow();
    expect(service.getCurrentPosition()).toEqual({ x: 0, z: 0, facing: 0 });
  });

  test('stop() remains the async lifecycle API', async () => {
    const result = service.stop();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});

import 'reflect-metadata';

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { ResolvedAction } from '../compiler/types';

/** A minimal mock compiler that lets us control resolveAction output. */
function makeMockCompiler(resolved: ResolvedAction | null) {
  return {
    resolveAction: mock((_action: string, _emotion: string, _intensity: number) => resolved),
    seedChannelBaseline: mock((_entries: Array<{ channel: string; value: number }>) => {}),
    getActionDuration: mock(() => undefined),
    getEffectiveJitter: mock(() => ({ duration: 0, intensity: 0, intensityFloor: 0.1 })),
    enqueue: mock(() => {}),
    getLayer: mock(() => undefined),
  };
}

describe('AvatarService.enqueueEmotion', () => {
  let service: AvatarService;

  beforeEach(() => {
    service = new AvatarService();
  });

  test('filters non-emotion channels and seeds only facial channels', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 0.7,
      targets: [
        { channel: 'mouth.smile', targetValue: 0.7, weight: 1 },
        { channel: 'head.yaw', targetValue: 0.5, weight: 1 },
        { channel: 'eye.smile.l', targetValue: 0.6, weight: 1 },
      ],
    };
    const compiler = makeMockCompiler(resolved);
    (service as any).compiler = compiler;

    service.enqueueEmotion('happy', 0.7);

    expect(compiler.resolveAction).toHaveBeenCalledTimes(1);
    expect(compiler.seedChannelBaseline).toHaveBeenCalledTimes(1);

    const seeded = compiler.seedChannelBaseline.mock.calls[0][0] as Array<{
      channel: string;
      value: number;
    }>;
    expect(seeded).toHaveLength(2);
    expect(seeded.find((e) => e.channel === 'mouth.smile')?.value).toBe(0.7);
    expect(seeded.find((e) => e.channel === 'eye.smile.l')?.value).toBe(0.6);
    expect(seeded.find((e) => e.channel === 'head.yaw')).toBeUndefined();
  });

  test('unknown emotion warns and does not call seedChannelBaseline', () => {
    const compiler = makeMockCompiler(null);
    (service as any).compiler = compiler;

    service.enqueueEmotion('unknown', 0.5);

    expect(compiler.seedChannelBaseline).not.toHaveBeenCalled();
  });

  test('intensity clamped to 0 when negative', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 0,
      targets: [{ channel: 'mouth.smile', targetValue: 0, weight: 1 }],
    };
    const compiler = makeMockCompiler(resolved);
    (service as any).compiler = compiler;

    service.enqueueEmotion('x', -0.5);

    // resolveAction should be called with clamped intensity = 0
    expect(compiler.resolveAction.mock.calls[0][2]).toBe(0);
  });

  test('intensity clamped to 1 when above 1', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 1,
      targets: [{ channel: 'mouth.smile', targetValue: 1, weight: 1 }],
    };
    const compiler = makeMockCompiler(resolved);
    (service as any).compiler = compiler;

    service.enqueueEmotion('x', 2);

    expect(compiler.resolveAction.mock.calls[0][2]).toBe(1);
  });

  test('no emotion channels in resolved targets → seedChannelBaseline NOT called', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 0.5,
      targets: [
        { channel: 'head.yaw', targetValue: 0.5, weight: 1 },
        { channel: 'body.lean', targetValue: 0.3, weight: 1 },
      ],
    };
    const compiler = makeMockCompiler(resolved);
    (service as any).compiler = compiler;

    service.enqueueEmotion('x', 0.5);

    expect(compiler.seedChannelBaseline).not.toHaveBeenCalled();
  });

  test('no-op when compiler is null', () => {
    // compiler defaults to null — just ensure no throw
    expect(() => service.enqueueEmotion('happy', 0.5)).not.toThrow();
  });
});

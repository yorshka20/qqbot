import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionMap } from './action-map';

describe('ActionMap.resolveAction', () => {
  const map = new ActionMap();

  it('returns a ResolvedAction with targets for a known action', () => {
    const result = map.resolveAction('smile', 'happy', 1.0);
    expect(result).not.toBeNull();
    expect(result!.targets).toBeDefined();
    expect(result!.targets.length).toBeGreaterThan(0);
  });

  it('returns null for an unknown action', () => {
    const result = map.resolveAction('nonexistent_action', 'neutral', 1.0);
    expect(result).toBeNull();
  });

  it('scales targets.targetValue by intensity', () => {
    const full = map.resolveAction('smile', 'happy', 1.0);
    const half = map.resolveAction('smile', 'happy', 0.5);
    expect(full).not.toBeNull();
    expect(half).not.toBeNull();
    for (let i = 0; i < full!.targets.length; i++) {
      expect(half!.targets[i].targetValue).toBeCloseTo(full!.targets[i].targetValue * 0.5);
    }
  });

  it('does not scale endPose.value by intensity', () => {
    // cross_arms has endPose entries
    const full = map.resolveAction('cross_arms', 'neutral', 1.0);
    const half = map.resolveAction('cross_arms', 'neutral', 0.5);
    expect(full).not.toBeNull();
    expect(half).not.toBeNull();
    expect(full!.endPose).toBeDefined();
    expect(half!.endPose).toBeDefined();
    // endPose values must be identical regardless of intensity
    for (let i = 0; i < full!.endPose!.length; i++) {
      expect(half!.endPose![i].value).toBe(full!.endPose![i].value);
    }
  });

  it('returns endPose for cross_arms with arm channels only', () => {
    const result = map.resolveAction('cross_arms', 'neutral', 1.0);
    expect(result).not.toBeNull();
    expect(result!.endPose).toBeDefined();
    const channels = result!.endPose!.map((e) => e.channel);
    expect(channels).toContain('arm.left');
    expect(channels).toContain('arm.right');
    // body.z and brow should NOT be in the endPose
    expect(channels).not.toContain('body.z');
    expect(channels).not.toContain('brow');
  });

  it('returns endPose for hand_on_hip with arm.right and body.x', () => {
    const result = map.resolveAction('hand_on_hip', 'neutral', 1.0);
    expect(result).not.toBeNull();
    expect(result!.endPose).toBeDefined();
    const channels = result!.endPose!.map((e) => e.channel);
    expect(channels).toContain('arm.right');
    expect(channels).toContain('body.x');
  });

  it('returns endPose for point_forward with arm.right only', () => {
    const result = map.resolveAction('point_forward', 'neutral', 1.0);
    expect(result).not.toBeNull();
    expect(result!.endPose).toBeDefined();
    const channels = result!.endPose!.map((e) => e.channel);
    expect(channels).toContain('arm.right');
    // head and body should NOT persist in endPose
    expect(channels).not.toContain('head.pitch');
    expect(channels).not.toContain('body.z');
  });

  it('endPose.value is smaller than the corresponding param peak', () => {
    // For point_forward, arm.right endPose.value should be less than params targetValue
    const result = map.resolveAction('point_forward', 'neutral', 1.0);
    expect(result).not.toBeNull();
    const armTarget = result!.targets.find((t) => t.channel === 'arm.right');
    const armEnd = result!.endPose!.find((e) => e.channel === 'arm.right');
    expect(armTarget).toBeDefined();
    expect(armEnd).toBeDefined();
    expect(armEnd!.value).toBeLessThan(armTarget!.targetValue);
  });
});

describe('ActionMap.listActions', () => {
  const map = new ActionMap();

  it('exposes description and category for cross_arms', () => {
    const actions = map.listActions();
    const entry = actions.find((a) => a.name === 'cross_arms');
    expect(entry).toBeDefined();
    expect(entry!.description).toBeTruthy();
    expect(entry!.category).toBe('movement');
  });

  it('exposes description and category for hand_on_hip', () => {
    const actions = map.listActions();
    const entry = actions.find((a) => a.name === 'hand_on_hip');
    expect(entry).toBeDefined();
    expect(entry!.description).toBeTruthy();
    expect(entry!.category).toBe('movement');
  });

  it('exposes description and category for point_forward', () => {
    const actions = map.listActions();
    const entry = actions.find((a) => a.name === 'point_forward');
    expect(entry).toBeDefined();
    expect(entry!.description).toBeTruthy();
    expect(entry!.category).toBe('movement');
  });

  it('lists channels for new actions', () => {
    const actions = map.listActions();
    const crossArms = actions.find((a) => a.name === 'cross_arms');
    expect(crossArms!.channels).toContain('arm.left');
    expect(crossArms!.channels).toContain('arm.right');

    const pointFwd = actions.find((a) => a.name === 'point_forward');
    expect(pointFwd!.channels).toContain('arm.right');
  });
});

// ---------------------------------------------------------------------------
// Variant + accompaniment + per-target-timing tests (Task 1 additions)
// ---------------------------------------------------------------------------
describe('ActionMap — variants', () => {
  let tmpDir: string;
  let tmpPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'actionmap-variants-'));
    tmpPath = join(tmpDir, 'map.json');
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('picks among variant entries on repeated resolveAction calls', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        foo: [
          { params: [{ channel: 'a', targetValue: 1, weight: 1 }], defaultDuration: 1000 },
          { params: [{ channel: 'b', targetValue: 2, weight: 1 }], defaultDuration: 2000 },
          { params: [{ channel: 'c', targetValue: 3, weight: 1 }], defaultDuration: 3000 },
        ],
      }),
    );
    const map = new ActionMap(tmpPath);
    const randSpy = spyOn(Math, 'random');
    // .mockReturnValueOnce chain:
    randSpy.mockReturnValueOnce(0).mockReturnValueOnce(0.4).mockReturnValueOnce(0.9);
    const r1 = map.resolveAction('foo', 'n', 1);
    const r2 = map.resolveAction('foo', 'n', 1);
    const r3 = map.resolveAction('foo', 'n', 1);
    randSpy.mockRestore();
    expect(r1!.targets[0].channel).toBe('a');
    expect(r2!.targets[0].channel).toBe('b');
    expect(r3!.targets[0].channel).toBe('c');
  });

  it('getDuration on variants returns rounded average', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        foo: [
          { params: [{ channel: 'a', targetValue: 1, weight: 1 }], defaultDuration: 1000 },
          { params: [{ channel: 'a', targetValue: 1, weight: 1 }], defaultDuration: 2000 },
        ],
      }),
    );
    const map = new ActionMap(tmpPath);
    expect(map.getDuration('foo')).toBe(1500);
  });

  it('listActions aggregates variants: duration average + channel union', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        foo: [
          {
            category: 'movement',
            description: 'desc A',
            params: [{ channel: 'a', targetValue: 1, weight: 1 }],
            defaultDuration: 1000,
          },
          {
            params: [{ channel: 'b', targetValue: 2, weight: 1 }],
            defaultDuration: 2000,
          },
        ],
      }),
    );
    const map = new ActionMap(tmpPath);
    const list = map.listActions();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('foo');
    expect(list[0].defaultDuration).toBe(1500);
    expect(list[0].category).toBe('movement');
    expect(list[0].description).toBe('desc A');
    expect(list[0].channels.sort()).toEqual(['a', 'b']);
  });
});

describe('ActionMap — accompaniment', () => {
  let tmpDir: string;
  let tmpPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'actionmap-accomp-'));
    tmpPath = join(tmpDir, 'map.json');
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges accompaniment targets into targets array after params', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        a: {
          params: [{ channel: 'x', targetValue: 1, weight: 1 }],
          accompaniment: [{ channel: 'y', targetValue: 2, weight: 0.5, leadMs: -100 }],
          defaultDuration: 1000,
        },
      }),
    );
    const map = new ActionMap(tmpPath);
    const r = map.resolveAction('a', 'neutral', 0.5);
    expect(r).not.toBeNull();
    expect(r!.targets).toHaveLength(2);
    expect(r!.targets[0]).toEqual({
      channel: 'x',
      targetValue: 0.5,
      weight: 1,
      oscillate: undefined,
      leadMs: undefined,
      lagMs: undefined,
    });
    expect(r!.targets[1]).toEqual({
      channel: 'y',
      targetValue: 1.0, // 2 * 0.5 intensity
      weight: 0.5,
      oscillate: undefined,
      leadMs: -100,
      lagMs: undefined,
    });
  });

  it('does not include accompaniment targets in endPose', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        a: {
          params: [{ channel: 'x', targetValue: 1, weight: 1 }],
          accompaniment: [{ channel: 'y', targetValue: 2, weight: 1 }],
          endPose: [{ channel: 'x', value: 0.5, weight: 1 }],
          defaultDuration: 1000,
        },
      }),
    );
    const map = new ActionMap(tmpPath);
    const r = map.resolveAction('a', 'neutral', 1);
    expect(r!.endPose).toEqual([{ channel: 'x', value: 0.5, weight: 1 }]);
    expect(r!.endPose!.some((e) => e.channel === 'y')).toBe(false);
  });

  it('listActions includes accompaniment channels in channels union', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        a: {
          params: [{ channel: 'x', targetValue: 1, weight: 1 }],
          accompaniment: [{ channel: 'y', targetValue: 2, weight: 1 }],
          defaultDuration: 1000,
        },
      }),
    );
    const map = new ActionMap(tmpPath);
    const list = map.listActions();
    expect(list[0].channels.sort()).toEqual(['x', 'y']);
  });
});

describe('ActionMap — per-target leadMs/lagMs clamping', () => {
  let tmpDir: string;
  let tmpPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'actionmap-clamp-'));
    tmpPath = join(tmpDir, 'map.json');
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clamps leadMs/lagMs silently to [-1000, +1000]', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        a: {
          params: [{ channel: 'x', targetValue: 1, weight: 1, leadMs: -5000, lagMs: 2000 }],
          defaultDuration: 1000,
        },
      }),
    );
    const map = new ActionMap(tmpPath);
    const r = map.resolveAction('a', 'neutral', 1);
    expect(r!.targets[0].leadMs).toBe(-1000);
    expect(r!.targets[0].lagMs).toBe(1000);
  });

  it('passes through undefined leadMs/lagMs as undefined', () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        a: {
          params: [{ channel: 'x', targetValue: 1, weight: 1 }],
          defaultDuration: 1000,
        },
      }),
    );
    const map = new ActionMap(tmpPath);
    const r = map.resolveAction('a', 'neutral', 1);
    expect(r!.targets[0].leadMs).toBeUndefined();
    expect(r!.targets[0].lagMs).toBeUndefined();
  });
});

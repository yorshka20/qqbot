import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionMap } from './action-map';
import type { ResolvedAction } from './types';

type EnvelopeAction = Extract<ResolvedAction, { kind: 'envelope' }>;

/** Narrow a ResolvedAction to the envelope branch; throws if it isn't. */
function asEnv(r: ResolvedAction | null): EnvelopeAction {
  if (!r || r.kind !== 'envelope') throw new Error('expected envelope ResolvedAction');
  return r;
}

function writeMapAndFixtures(entries: Record<string, unknown>, fixtures: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'am-'));
  for (const [relPath, content] of Object.entries(fixtures)) {
    const fullPath = join(dir, relPath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(content));
  }
  const mapPath = join(dir, 'action-map.json');
  writeFileSync(mapPath, JSON.stringify(entries));
  return mapPath;
}

describe('ActionMap.resolveAction', () => {
  const map = new ActionMap();

  it('returns a ResolvedAction with targets for a known action', () => {
    const result = map.resolveAction('smile', 'happy', 1.0);
    expect(result).not.toBeNull();
    expect(asEnv(result).targets).toBeDefined();
    expect(asEnv(result).targets.length).toBeGreaterThan(0);
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
    const fullEnv = asEnv(full);
    const halfEnv = asEnv(half);
    for (let i = 0; i < fullEnv.targets.length; i++) {
      expect(halfEnv.targets[i].targetValue).toBeCloseTo(fullEnv.targets[i].targetValue * 0.5);
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
    const env = asEnv(result);
    const armTarget = env.targets.find((t) => t.channel === 'arm.right');
    const armEnd = env.endPose!.find((e) => e.channel === 'arm.right');
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
    expect(asEnv(r1).targets[0].channel).toBe('a');
    expect(asEnv(r2).targets[0].channel).toBe('b');
    expect(asEnv(r3).targets[0].channel).toBe('c');
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
    const env = asEnv(r);
    expect(env.targets).toHaveLength(2);
    expect(env.targets[0]).toEqual({
      channel: 'x',
      targetValue: 0.5,
      weight: 1,
      oscillate: undefined,
      leadMs: undefined,
      lagMs: undefined,
    });
    expect(env.targets[1]).toEqual({
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
    expect(asEnv(r).targets[0].leadMs).toBe(-1000);
    expect(asEnv(r).targets[0].lagMs).toBe(1000);
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
    expect(asEnv(r).targets[0].leadMs).toBeUndefined();
    expect(asEnv(r).targets[0].lagMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Clip kind tests (Task 1 additions)
// ---------------------------------------------------------------------------

const clipFixture = {
  id: 'bow',
  duration: 2,
  tracks: [
    {
      channel: 'vrm.spine.x',
      keyframes: [
        { time: 0, value: 0 },
        { time: 2, value: 0.5 },
      ],
    },
  ],
};

describe('ActionMap — clip kind', () => {
  it('resolves a clip action', () => {
    const mapPath = writeMapAndFixtures(
      { bow: { kind: 'clip', clip: 'clips/vrm/bow.json' } },
      { 'clips/vrm/bow.json': clipFixture },
    );
    const map = new ActionMap(mapPath);
    const r = map.resolveAction('bow', 'neutral', 1.0);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('clip');
    if (r !== null && r.kind === 'clip') {
      expect(r.clip.id).toBe('bow');
      expect(r.duration).toBe(2000);
      expect(r.intensity).toBe(1.0);
    }
  });

  it('culls action with missing clip file', () => {
    const mapPath = writeMapAndFixtures({ broken: { kind: 'clip', clip: 'clips/vrm/missing.json' } }, {});
    const map = new ActionMap(mapPath);
    expect(map.has('broken')).toBe(false);
    expect(map.resolveAction('broken', 'neutral', 1.0)).toBeNull();
  });

  it('resolves clip variant pool — both variants reachable', () => {
    const fixtureA = { id: 'a', duration: 1, tracks: [] };
    const fixtureB = { id: 'b', duration: 1, tracks: [] };
    const mapPath = writeMapAndFixtures(
      {
        multi: [
          { kind: 'clip', clip: 'clips/vrm/a.json' },
          { kind: 'clip', clip: 'clips/vrm/b.json' },
        ],
      },
      { 'clips/vrm/a.json': fixtureA, 'clips/vrm/b.json': fixtureB },
    );
    const map = new ActionMap(mapPath);
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = map.resolveAction('multi', 'neutral', 1.0);
      if (r && r.kind === 'clip') ids.add(r.clip.id);
    }
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
  });

  it('resolves envelope backwards-compat (kind returns envelope)', () => {
    const mapPath = writeMapAndFixtures(
      { smile: { params: [{ channel: 'mouth.smile', targetValue: 1, weight: 1 }], defaultDuration: 1000 } },
      {},
    );
    const map = new ActionMap(mapPath);
    const r = map.resolveAction('smile', 'neutral', 0.5);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('envelope');
    const env = asEnv(r);
    expect(env.targets[0].channel).toBe('mouth.smile');
    expect(env.targets[0].targetValue).toBe(0.5);
    expect(env.duration).toBe(1000);
    expect(env.intensity).toBe(0.5);
  });

  it('getClipByActionName returns clip for clip action, null for envelope/unknown', () => {
    const mapPath = writeMapAndFixtures(
      {
        bow: { kind: 'clip', clip: 'clips/vrm/bow.json' },
        smile: { params: [{ channel: 'mouth.smile', targetValue: 1, weight: 1 }], defaultDuration: 1000 },
      },
      { 'clips/vrm/bow.json': clipFixture },
    );
    const map = new ActionMap(mapPath);
    expect(map.getClipByActionName('bow')).not.toBeNull();
    expect(map.getClipByActionName('bow')!.id).toBe('bow');
    expect(map.getClipByActionName('smile')).toBeNull();
    expect(map.getClipByActionName('unknown')).toBeNull();
  });

  it('listActions on clip entry: channels from tracks, duration from clip', () => {
    const mapPath = writeMapAndFixtures(
      { bow: { kind: 'clip', clip: 'clips/vrm/bow.json', category: 'movement', description: 'bow' } },
      { 'clips/vrm/bow.json': clipFixture },
    );
    const map = new ActionMap(mapPath);
    const list = map.listActions();
    const entry = list.find((a) => a.name === 'bow');
    expect(entry).toBeDefined();
    expect(entry!.channels).toContain('vrm.spine.x');
    expect(entry!.category).toBe('movement');
    expect(entry!.defaultDuration).toBe(2000);
  });

  it('getDuration on clip entry returns clip.duration*1000 when defaultDuration absent', () => {
    const mapPath = writeMapAndFixtures(
      { bow: { kind: 'clip', clip: 'clips/vrm/bow.json' } },
      { 'clips/vrm/bow.json': clipFixture },
    );
    const map = new ActionMap(mapPath);
    expect(map.getDuration('bow')).toBe(2000);
  });

  it('getDuration on clip entry uses variant.defaultDuration when set', () => {
    const mapPath = writeMapAndFixtures(
      { bow: { kind: 'clip', clip: 'clips/vrm/bow.json', defaultDuration: 1500 } },
      { 'clips/vrm/bow.json': clipFixture },
    );
    const map = new ActionMap(mapPath);
    expect(map.getDuration('bow')).toBe(1500);
  });

  it('rejects mixed kind in variant array', () => {
    const mapPath = writeMapAndFixtures(
      {
        mix: [
          { params: [{ channel: 'x', targetValue: 1, weight: 1 }], defaultDuration: 1000 },
          { kind: 'clip', clip: 'clips/vrm/a.json' },
        ],
      },
      { 'clips/vrm/a.json': { id: 'a', duration: 1, tracks: [] } },
    );
    const map = new ActionMap(mapPath);
    expect(map.has('mix')).toBe(false);
  });
});

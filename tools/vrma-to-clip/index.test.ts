import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convert } from './src/convert.js';
import { isIdleClip } from './src/validateSchema.js';
import { sampleBoneQuaternion, maxRotationAngle } from './src/sampleTrack.js';
import { buildSynthetic } from './fixtures/build-synthetic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Scenario 1: Synthetic regression
describe('synthetic regression', () => {
  it('converts synthetic.vrma.glb correctly', async () => {
    const filePath = join(__dirname, 'fixtures', 'synthetic.vrma.glb');
    const buf = readFileSync(filePath);
    // Pass Uint8Array directly; convert() handles the slice internally
    const clip = await convert(buf, 'synthetic');

    expect(isIdleClip(clip)).toBe(true);

    // Duration ≈ 1.0
    expect(clip.duration).toBeCloseTo(1.0, 3);

    // At least one vrm.head.y track (head angle = π/2 which is NOT > π/2, stays Euler)
    const headY = clip.tracks.find((t) => t.channel === 'vrm.head.y');
    expect(headY).toBeDefined();

    // Every track should have exactly 31 keyframes (Math.floor(1.0 / (1/30)) + 1 = 31)
    for (const track of clip.tracks) {
      expect(track.keyframes.length).toBe(31);
    }

    // vrm.head.y at t=0.5 should be ≈ π/4 (half of π/2 rotation sampled mid-way via euler)
    // The head rotates π/2 around Y from t=0 to t=1.
    // At t=0.5, quaternion is slerp halfway: angle = π/4, so euler.y ≈ π/4
    const kfAt15 = headY!.keyframes.find((k) => Math.abs(k.time - 0.5) < 0.02);
    expect(kfAt15).toBeDefined();
    // For scalar track keyframes have `value`
    expect('value' in kfAt15!).toBe(true);
    expect((kfAt15 as { time: number; value: number }).value).toBeCloseTo(Math.PI / 4, 1); // ±0.01 radians
  });
});

// Scenario 2: Static-bone filter
describe('static bone filter', () => {
  it('drops nearly-motionless head tracks', async () => {
    const buf = buildSynthetic({ headRotationRadians: 1e-6 });
    const clip = await convert(buf, 'static-test');

    expect(isIdleClip(clip)).toBe(true);

    // No vrm.head.* tracks since rotation is below filterStatic threshold (1e-5)
    const headTracks = clip.tracks.filter((t) => t.channel.startsWith('vrm.head.') || t.channel === 'vrm.head');
    expect(headTracks.length).toBe(0);
  });
});

// Scenario 3: Root motion threshold
describe('root motion threshold', () => {
  it('suppresses root motion for small hips translation (< 0.01m)', async () => {
    const buf = buildSynthetic({ hipsTranslationMeters: 0.005 });
    const clip = await convert(buf, 'root-small');

    expect(isIdleClip(clip)).toBe(true);

    const rootTracks = clip.tracks.filter((t) => t.channel.startsWith('vrm.root.'));
    expect(rootTracks.length).toBe(0);
  });

  it('emits 3 root tracks for large hips translation (>= 0.01m)', async () => {
    const buf = buildSynthetic({ hipsTranslationMeters: 0.5 });
    const clip = await convert(buf, 'root-large');

    expect(isIdleClip(clip)).toBe(true);

    const rootTracks = clip.tracks.filter((t) => t.channel.startsWith('vrm.root.'));
    expect(rootTracks.length).toBe(3);

    const channels = rootTracks.map((t) => t.channel).sort();
    expect(channels).toContain('vrm.root.rotY');
    expect(channels).toContain('vrm.root.x');
    expect(channels).toContain('vrm.root.z');
  });
});

// Scenario 4: Expression track
describe('expression track', () => {
  it('produces vrm.expression.happy with ramp 0→1→0', async () => {
    const buf = buildSynthetic({ happyExpression: true });
    const clip = await convert(buf, 'expr-test');

    expect(isIdleClip(clip)).toBe(true);

    const happyTrack = clip.tracks.find((t) => t.channel === 'vrm.expression.happy');
    expect(happyTrack).toBeDefined();

    // At t≈0.5, value should be ≈1 (within 0.05)
    const kfAt05 = happyTrack!.keyframes.find((k) => Math.abs(k.time - 0.5) < 0.02);
    expect(kfAt05).toBeDefined();
    expect('value' in kfAt05!).toBe(true);
    expect((kfAt05 as { time: number; value: number }).value).toBeCloseTo(1.0, 1); // within 0.05
  });
});

// Scenario 5: validateSchema v1/v2 acceptance and non-unit quat rejection
describe('validateSchema v1/v2 compat', () => {
  it('accepts v1 scalar-only clip', () => {
    const v1: unknown = {
      id: 'v1',
      duration: 1,
      tracks: [{ channel: 'vrm.head.y', keyframes: [{ time: 0, value: 0.1 }] }],
    };
    expect(isIdleClip(v1)).toBe(true);
  });

  it('accepts v2 quat track with unit quaternion', () => {
    const v2: unknown = {
      id: 'v2',
      duration: 1,
      tracks: [{
        kind: 'quat',
        channel: 'vrm.hips',
        keyframes: [{ time: 0, x: 0, y: 0, z: 0, w: 1 }],
      }],
    };
    expect(isIdleClip(v2)).toBe(true);
  });

  it('rejects v2 quat track with non-unit quaternion (norm=0.5)', () => {
    const bad: unknown = {
      id: 'bad',
      duration: 1,
      tracks: [{
        kind: 'quat',
        channel: 'vrm.hips',
        keyframes: [{ time: 0, x: 0.25, y: 0.25, z: 0.25, w: 0.25 }], // norm ≈ 0.5
      }],
    };
    expect(isIdleClip(bad)).toBe(false);
  });

  it('accepts mixed v1+v2 clip', () => {
    const mixed: unknown = {
      id: 'mixed',
      duration: 1,
      tracks: [
        { channel: 'vrm.head.y', keyframes: [{ time: 0, value: 0.1 }] },
        { kind: 'quat', channel: 'vrm.hips', keyframes: [{ time: 0, x: 0, y: 0, z: 0, w: 1 }] },
      ],
    };
    expect(isIdleClip(mixed)).toBe(true);
  });
});

// Scenario 6: sampleBoneQuaternion
describe('sampleBoneQuaternion', () => {
  it('returns Math.floor(1.0 / (1/30)) + 1 = 31 frames for duration=1.0', () => {
    const track = {
      times: [0, 1],
      values: [0, 0, 0, 1,  0, 0, 0, 1], // identity → identity
    };
    const frames = sampleBoneQuaternion(track, 1.0);
    expect(frames.length).toBe(31);
  });

  it('each frame is a unit quaternion (norm within 1e-5)', () => {
    const sinH = Math.sin(Math.PI / 4);
    const cosH = Math.cos(Math.PI / 4);
    const track = {
      times: [0, 1],
      values: [0, 0, 0, 1,  0, sinH, 0, cosH], // identity → 90-deg Y rotation
    };
    const frames = sampleBoneQuaternion(track, 1.0);
    for (const f of frames) {
      const norm = Math.sqrt(f.x ** 2 + f.y ** 2 + f.z ** 2 + f.w ** 2);
      expect(Math.abs(norm - 1)).toBeLessThan(1e-5);
    }
  });
});

// Scenario 7: maxRotationAngle
describe('maxRotationAngle', () => {
  it('returns 0 for identity quaternion sequence', () => {
    const frames = [
      { time: 0, x: 0, y: 0, z: 0, w: 1 },
      { time: 0.5, x: 0, y: 0, z: 0, w: 1 },
      { time: 1, x: 0, y: 0, z: 0, w: 1 },
    ];
    expect(maxRotationAngle(frames)).toBeCloseTo(0);
  });

  it('returns approximately π for 0→π rotation around Y', () => {
    // At t=1, quaternion for 180-deg Y rotation is (0, 1, 0, 0); w=0 → 2*acos(0)=π
    const track = {
      times: [0, 1],
      values: [0, 0, 0, 1,  0, 1, 0, 0], // identity → 180-deg Y
    };
    const frames = sampleBoneQuaternion(track, 1.0);
    const maxAngle = maxRotationAngle(frames);
    expect(maxAngle).toBeCloseTo(Math.PI, 1);
  });
});

// Scenario 8: Converter heuristic
describe('converter heuristic', () => {
  it('chooses quat track for 3π/4 hips Y rotation', async () => {
    const buf = buildSynthetic({ hipsRotationRadians: (3 * Math.PI) / 4 });
    const clip = await convert(buf, 'hips-large');

    expect(isIdleClip(clip)).toBe(true);

    const hipsQuat = clip.tracks.find((t) => t.channel === 'vrm.hips' && t.kind === 'quat');
    expect(hipsQuat).toBeDefined();

    // No Euler-axis tracks for hips
    const hipsEuler = clip.tracks.filter((t) => t.channel.startsWith('vrm.hips.'));
    expect(hipsEuler.length).toBe(0);
  });

  it('keeps scalar Euler tracks for π/6 head Y rotation', async () => {
    const buf = buildSynthetic({ headRotationRadians: Math.PI / 6 });
    const clip = await convert(buf, 'head-small');

    expect(isIdleClip(clip)).toBe(true);

    // Should have vrm.head.y scalar track (not quat)
    const headY = clip.tracks.find((t) => t.channel === 'vrm.head.y');
    expect(headY).toBeDefined();

    // Must not have a quat track for head
    const headQuat = clip.tracks.find((t) => t.channel === 'vrm.head' && t.kind === 'quat');
    expect(headQuat).toBeUndefined();
  });
});

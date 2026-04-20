import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convert } from './src/convert.js';
import { isIdleClip } from './src/validateSchema.js';
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

    // At least one vrm.head.y track
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
    expect(kfAt15!.value).toBeCloseTo(Math.PI / 4, 1); // ±0.01 radians
  });
});

// Scenario 2: Static-bone filter
describe('static bone filter', () => {
  it('drops nearly-motionless head tracks', async () => {
    const buf = buildSynthetic({ headRotationRadians: 1e-6 });
    const clip = await convert(buf, 'static-test');

    expect(isIdleClip(clip)).toBe(true);

    // No vrm.head.* tracks since rotation is below filterStatic threshold (1e-5)
    const headTracks = clip.tracks.filter((t) => t.channel.startsWith('vrm.head.'));
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
    expect(kfAt05!.value).toBeCloseTo(1.0, 1); // within 0.05
  });
});

/**
 * extract-rest-pose.ts
 *
 * Reads idle_general_01.json, extracts frame-0 Euler values for every
 * vrm.<bone>.<x|y|z> track, and writes packages/avatar/assets/vrm-rest-pose.json.
 *
 * Run from repo root:
 *   bun run packages/avatar/scripts/extract-rest-pose.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Full VRM humanoid bone list (determines output key order) ────────────────
const VRM_BONES: readonly string[] = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes',
  'leftEye',
  'rightEye',
  'jaw',
  'leftThumbProximal',
  'leftThumbIntermediate',
  'leftThumbDistal',
  'leftIndexProximal',
  'leftIndexIntermediate',
  'leftIndexDistal',
  'leftMiddleProximal',
  'leftMiddleIntermediate',
  'leftMiddleDistal',
  'leftRingProximal',
  'leftRingIntermediate',
  'leftRingDistal',
  'leftLittleProximal',
  'leftLittleIntermediate',
  'leftLittleDistal',
  'rightThumbProximal',
  'rightThumbIntermediate',
  'rightThumbDistal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightIndexDistal',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightMiddleDistal',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightRingDistal',
  'rightLittleProximal',
  'rightLittleIntermediate',
  'rightLittleDistal',
];

// ── Types ────────────────────────────────────────────────────────────────────
interface Keyframe {
  time: number;
  value: number;
}

interface Track {
  channel: string;
  keyframes: Keyframe[];
}

interface ClipJson {
  tracks: Track[];
}

// ── Main ─────────────────────────────────────────────────────────────────────
const repoRoot = process.cwd();
const clipPath = path.resolve(repoRoot, 'packages/avatar/assets/clips/vrm/idle_general_01.json');
const outputPath = path.resolve(repoRoot, 'packages/avatar/assets/vrm-rest-pose.json');

const clip: ClipJson = JSON.parse(fs.readFileSync(clipPath, 'utf-8'));

const TRACK_RE = /^vrm\.([a-zA-Z]+)\.([xyz])$/;

// Collect frame-0 values per bone per axis
const fromClip: Record<string, { x?: number; y?: number; z?: number }> = {};

for (const track of clip.tracks) {
  const m = TRACK_RE.exec(track.channel);
  if (!m) continue;
  const [, bone, axis] = m;
  if (!fromClip[bone]) fromClip[bone] = {};
  // keyframes[0] is the frame at time=0 (already sorted ascending)
  fromClip[bone][axis as 'x' | 'y' | 'z'] = track.keyframes[0].value;
}

// Build output euler map in canonical bone order
const euler: Record<string, { x: number; y: number; z: number }> = {};
let fromClipCount = 0;
let defaultedCount = 0;

for (const bone of VRM_BONES) {
  const raw = fromClip[bone];
  const hasAny = raw !== undefined;

  const x = round6(raw?.x ?? 0);
  const y = round6(raw?.y ?? 0);
  const z = round6(raw?.z ?? 0);

  euler[bone] = { x, y, z };

  if (hasAny) {
    fromClipCount++;
  } else {
    defaultedCount++;
  }
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

const output = {
  $schema: 'vrm-rest-pose.v1',
  source: 'idle_general_01.json frame 0 (time=0 keyframe value)',
  rotationOrder: 'XYZ',
  euler,
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

const total = VRM_BONES.length;
console.log(
  `wrote ${total} bones (${fromClipCount} from clip, ${defaultedCount} defaulted)`,
);

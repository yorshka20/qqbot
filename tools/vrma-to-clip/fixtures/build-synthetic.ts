import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface SyntheticOpts {
  /** Y-axis rotation in radians. Default: Math.PI / 2 */
  headRotationRadians?: number;
  /** Hips X translation in meters. If set, adds a hips translation animation channel. */
  hipsTranslationMeters?: number;
  /** If true, adds a happy expression ramp 0→1→0 over 1 second. */
  happyExpression?: boolean;
}

/**
 * Build an in-memory synthetic VRMA (.glb) buffer.
 *
 * The fixture always includes:
 *  - hips bone (node 0) at [0, 1, 0] — required so the loader can build the
 *    bone world-matrix map and process head's parent chain
 *  - head bone (node 1) — with configurable Y rotation
 *
 * Optional:
 *  - hips translation animation channel (if hipsTranslationMeters set)
 *  - happy expression proxy node + animation channel (if happyExpression true)
 */
export function buildSynthetic(opts: SyntheticOpts = {}): Uint8Array {
  const headAngle = opts.headRotationRadians ?? Math.PI / 2;
  const hipsTranslation = opts.hipsTranslationMeters;
  const happy = opts.happyExpression ?? false;

  // --- Compute quaternion for head rotation ---
  // Rotation of headAngle around Y axis: q = [0, sin(angle/2), 0, cos(angle/2)]
  const halfAngle = headAngle / 2;
  const sinH = Math.sin(halfAngle);
  const cosH = Math.cos(halfAngle);

  const parts: number[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const channels: object[] = [];
  const samplers: object[] = [];

  // Fixed node layout:
  //   0: hips    (always present, at y=1 to satisfy loader's T-pose check)
  //   1: head    (always present)
  //   2: expressionProxy_happy (optional)
  const nodes: object[] = [
    { name: 'hips', translation: [0, 1, 0] },
    { name: 'head' },
  ];
  const humanBones: Record<string, { node: number }> = {
    hips: { node: 0 },
    head: { node: 1 },
  };
  const expressionsPreset: Record<string, { node: number }> = {};

  let offset = 0;
  let accessorIdx = 0;
  let channelIdx = 0;

  // --- Head rotation channel (always present) ---
  // Head times: [0.0, 1.0]
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 8 });
  accessors.push({
    bufferView: accessors.length,
    componentType: 5126,
    count: 2,
    type: 'SCALAR',
    min: [0.0],
    max: [1.0],
  });
  parts.push(0.0, 1.0);
  offset += 8;
  const headTimesAcc = accessorIdx++;

  // Head quaternion values: identity → rotated
  const headQuatData = [
    0, 0, 0, 1,       // t=0: identity
    0, sinH, 0, cosH, // t=1: rotated around Y
  ];
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 32 });
  accessors.push({
    bufferView: accessors.length,
    componentType: 5126,
    count: 2,
    type: 'VEC4',
  });
  parts.push(...headQuatData);
  offset += 32;
  const headQuatAcc = accessorIdx++;

  samplers.push({ input: headTimesAcc, interpolation: 'LINEAR', output: headQuatAcc });
  channels.push({ sampler: channelIdx, target: { node: 1, path: 'rotation' } });
  channelIdx++;

  // --- Hips translation channel (optional) ---
  if (hipsTranslation !== undefined) {
    // Hips times: [0.0, 1.0]
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 8 });
    accessors.push({
      bufferView: accessors.length,
      componentType: 5126,
      count: 2,
      type: 'SCALAR',
      min: [0.0],
      max: [1.0],
    });
    parts.push(0.0, 1.0);
    offset += 8;
    const hipsTimesAcc = accessorIdx++;

    // Hips translation: [0,1,0] → [m,1,0] (X = the translation metric)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 24 });
    accessors.push({
      bufferView: accessors.length,
      componentType: 5126,
      count: 2,
      type: 'VEC3',
    });
    parts.push(0, 1, 0, hipsTranslation, 1, 0);
    offset += 24;
    const hipsValAcc = accessorIdx++;

    samplers.push({ input: hipsTimesAcc, interpolation: 'LINEAR', output: hipsValAcc });
    channels.push({ sampler: channelIdx, target: { node: 0, path: 'translation' } });
    channelIdx++;
  }

  // --- Happy expression channel (optional) ---
  if (happy) {
    const exprNodeIdx = nodes.length;
    nodes.push({ name: 'expressionProxy_happy' });
    expressionsPreset['happy'] = { node: exprNodeIdx };

    // Expression times: [0.0, 0.5, 1.0]
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 12 });
    accessors.push({
      bufferView: accessors.length,
      componentType: 5126,
      count: 3,
      type: 'SCALAR',
      min: [0.0],
      max: [1.0],
    });
    parts.push(0.0, 0.5, 1.0);
    offset += 12;
    const exprTimesAcc = accessorIdx++;

    // Expression values: VEC3 translation where X = expression weight
    // Ramp: 0→1→0
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 36 });
    accessors.push({
      bufferView: accessors.length,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
    });
    parts.push(0, 0, 0, 1, 0, 0, 0, 0, 0);
    offset += 36;
    const exprValAcc = accessorIdx++;

    samplers.push({ input: exprTimesAcc, interpolation: 'LINEAR', output: exprValAcc });
    channels.push({ sampler: channelIdx, target: { node: exprNodeIdx, path: 'translation' } });
    channelIdx++;
  }

  // --- Build binary chunk ---
  const binData = new Float32Array(parts);
  const binBytes = new Uint8Array(binData.buffer);
  const binPadded = padTo4(binBytes, 0x00);

  // --- Build glTF JSON ---
  const vrmcExtension: Record<string, unknown> = {
    specVersion: '1.0',
    humanoid: { humanBones },
  };
  if (Object.keys(expressionsPreset).length > 0) {
    vrmcExtension['expressions'] = { preset: expressionsPreset };
  }

  const nodeIndices = nodes.map((_, i) => i);
  const gltfJson = {
    asset: { version: '2.0' },
    extensionsUsed: ['VRMC_vrm_animation'],
    scene: 0,
    scenes: [{ nodes: nodeIndices }],
    nodes,
    animations: [{ channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binPadded.length }],
    extensions: {
      VRMC_vrm_animation: vrmcExtension,
    },
  };

  const jsonStr = JSON.stringify(gltfJson);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPadded = padTo4(jsonBytes, 0x20); // pad with spaces (0x20)

  // --- Assemble GLB container ---
  const chunkHeaderSize = 8;
  const headerSize = 12;
  const jsonChunkSize = chunkHeaderSize + jsonPadded.length;
  const binChunkSize = chunkHeaderSize + binPadded.length;
  const totalLength = headerSize + jsonChunkSize + binChunkSize;

  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  let pos = 0;

  // GLB header
  view.setUint32(pos, 0x46546c67, true); pos += 4; // magic "glTF"
  view.setUint32(pos, 2, true);           pos += 4; // version 2
  view.setUint32(pos, totalLength, true); pos += 4; // total byte length

  // JSON chunk
  view.setUint32(pos, jsonPadded.length, true); pos += 4;
  view.setUint32(pos, 0x4e4f534a, true);        pos += 4; // "JSON"
  glb.set(jsonPadded, pos); pos += jsonPadded.length;

  // BIN chunk
  view.setUint32(pos, binPadded.length, true); pos += 4;
  view.setUint32(pos, 0x004e4942, true);       pos += 4; // "BIN\0"
  glb.set(binPadded, pos);

  return glb;
}

function padTo4(data: Uint8Array, padByte: number): Uint8Array {
  const rem = data.length % 4;
  if (rem === 0) return data;
  const padLen = 4 - rem;
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out.fill(padByte, data.length);
  return out;
}

// --- CLI entry: write fixtures/synthetic.vrma.glb ---
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('build-synthetic.ts') ||
    process.argv[1].endsWith('build-synthetic.js'));

if (isMain) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, 'synthetic.vrma.glb');
  const glb = buildSynthetic();
  writeFileSync(outPath, glb);
  console.log(`Written: ${outPath} (${glb.length} bytes)`);
}

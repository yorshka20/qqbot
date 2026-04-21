import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import type { VRMAnimation } from '@pixiv/three-vrm-animation';
import { sampleBoneEulerXYZ, sampleBoneQuaternion, maxRotationAngle, filterStatic } from './sampleTrack.js';
import { extractRootMotion } from './rootMotion.js';
import { sampleExpressions } from './expressions.js';
import type { IdleClip, IdleClipTrack } from './validateSchema.js';

/**
 * Convert a VRMA (.vrma / .glb) buffer into an IdleClip JSON.
 *
 * For each bone rotation track the converter first samples quaternion frames
 * and computes the maximum rotation angle. If the angle exceeds π/2, the bone
 * receives a v2 `kind:'quat'` track (avoids Euler XYZ fold/flip for large
 * rotations such as hips Y-axis spinning). Otherwise the existing 3-axis Euler
 * XYZ path is used and static tracks are filtered out.
 *
 * @param buffer - Raw file bytes
 * @param id     - Clip identifier (usually the source filename without extension)
 */
export async function convert(buffer: ArrayBuffer | Uint8Array, id: string): Promise<IdleClip> {
  let arrayBuffer: ArrayBuffer;
  if (buffer instanceof Uint8Array) {
    // Copy to a new plain ArrayBuffer to avoid SharedArrayBuffer issues
    arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  } else {
    arrayBuffer = buffer;
  }

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const gltf = await loader.parseAsync(arrayBuffer, '');
  const vrmAnimations: VRMAnimation[] | undefined = gltf.userData['vrmAnimations'];

  if (!vrmAnimations || vrmAnimations.length === 0) {
    throw new Error('No VRM animations found in the provided file.');
  }

  const vrmAnim = vrmAnimations[0];
  const duration = vrmAnim.duration;
  const dt = 1 / 30;

  const tracks: IdleClipTrack[] = [];

  // --- Bone rotation tracks ---
  for (const [boneName, rotationTrack] of vrmAnim.humanoidTracks.rotation) {
    const quatTrackData = { times: rotationTrack.times, values: rotationTrack.values };
    const quatFrames = sampleBoneQuaternion(quatTrackData, duration, dt);
    const maxAngle = maxRotationAngle(quatFrames);

    if (maxAngle > Math.PI / 2) {
      // Large-angle path: emit a v2 quat track to avoid Euler XYZ fold/flip.
      // filterStatic() is not applied to quat tracks.
      tracks.push({ kind: 'quat', channel: `vrm.${boneName}`, keyframes: quatFrames });
    } else {
      // Small-angle path: decompose to Euler XYZ and drop static axes.
      const { xTrack, yTrack, zTrack } = sampleBoneEulerXYZ(quatTrackData, duration, dt);

      if (filterStatic(xTrack)) {
        tracks.push({ channel: `vrm.${boneName}.x`, keyframes: xTrack });
      }
      if (filterStatic(yTrack)) {
        tracks.push({ channel: `vrm.${boneName}.y`, keyframes: yTrack });
      }
      if (filterStatic(zTrack)) {
        tracks.push({ channel: `vrm.${boneName}.z`, keyframes: zTrack });
      }
    }
  }

  // --- Root motion (hips translation + hips Y rotation) ---
  // Root motion path is unchanged; it always extracts from hips regardless of
  // whether hips got a quat or Euler bone track above.
  const hipsTranslation = vrmAnim.humanoidTracks.translation.get('hips') ?? null;
  const hipsRotation = vrmAnim.humanoidTracks.rotation.get('hips') ?? null;

  const rootMotion = extractRootMotion(
    hipsTranslation ? { times: hipsTranslation.times, values: hipsTranslation.values } : null,
    hipsRotation ? { times: hipsRotation.times, values: hipsRotation.values } : null,
    duration,
    dt,
  );

  if (rootMotion) {
    tracks.push({ channel: 'vrm.root.x', keyframes: rootMotion.rootX });
    tracks.push({ channel: 'vrm.root.z', keyframes: rootMotion.rootZ });
    tracks.push({ channel: 'vrm.root.rotY', keyframes: rootMotion.rootRotY });
  }

  // --- Expression tracks ---
  const expressionMap = new Map<string, { times: Float32Array; values: Float32Array }>();

  for (const [name, track] of vrmAnim.expressionTracks.preset) {
    expressionMap.set(name, { times: track.times, values: track.values });
  }
  for (const [name, track] of vrmAnim.expressionTracks.custom) {
    expressionMap.set(name, { times: track.times, values: track.values });
  }

  const expressionTracks = sampleExpressions(expressionMap, duration, dt);
  for (const et of expressionTracks) {
    tracks.push(et);
  }

  return { id, duration, tracks };
}

# IdleClip Schema

## Overview

An `IdleClip` is the JSON serialization format for avatar animation clips. Each clip drives one or more channels in the animation compiler via a sequence of keyframes.

## Top-Level Structure

```jsonc
{
  "id": "VRMA_05",          // string — unique clip identifier
  "duration": 9.317,        // number — clip length in seconds
  "tracks": [ ... ]         // array of IdleClipTrack
}
```

## Track Types

### v1 — Scalar Track (backward compatible)

```jsonc
{
  "channel": "vrm.head.y",  // dot-separated channel name with axis suffix
  "kind": "scalar",         // optional; omit for pure-v1 files
  "easing": "easeInOut",    // optional easing hint
  "keyframes": [
    { "time": 0.0, "value": 0.0 },
    { "time": 0.5, "value": 0.785 }
  ]
}
```

Scalar tracks animate a single float channel in the compiler. The channel name carries the axis suffix (`.x`, `.y`, `.z`) when representing a Euler-decomposed bone rotation. Keyframes interpolate linearly unless an `easing` is specified.

### v2 — Quaternion Track

```jsonc
{
  "kind": "quat",           // discriminator — required
  "channel": "vrm.hips",   // base bone channel — NO axis suffix
  "keyframes": [
    { "time": 0.0, "x": 0, "y": 0, "z": 0, "w": 1 },
    { "time": 1.0, "x": 0, "y": 0.707, "z": 0, "w": 0.707 }
  ]
}
```

Quaternion tracks store unit quaternions (`|q| = 1 ± 1e-3`) sampled at 30 Hz. The `channel` value is the base bone name (e.g. `vrm.hips`) without any axis suffix.

## Why Two Track Types?

Euler XYZ decomposition folds and flips when a bone rotation exceeds π/2 radians (≈ 90°). For example, hips spinning during a dance or bow motion easily exceeds this threshold. Storing quaternions directly avoids the discontinuity.

**Converter heuristic** (`tools/vrma-to-clip`):

```
maxAngle = max over sampled frames of (2 × acos(|w|))
if maxAngle > π/2  →  emit kind:'quat' track
else               →  decompose to Euler XYZ, drop static axes
```

## Compiler: Quaternion Channel Contract

When the animation compiler processes a `kind:'quat'` track it:

1. **Slerps with identity**: contribution `q_out = slerp(identity, q_clip, k)` where `k = clamp(intensity × envelopeScale × fadeScale, 0, 1)`
2. **Emits four scalar params**: `vrm.<bone>.qx`, `vrm.<bone>.qy`, `vrm.<bone>.qz`, `vrm.<bone>.qw`
3. **Bypasses spring-damper**: quat output channels go directly into `currentParams`, no spring state is created
4. **Bypasses channel baseline**: quat channels are excluded from the baseline additive step
5. **Disappear automatically**: if no clip contributes a quat channel in a given tick, that channel is absent from `currentParams` (it is not held at the previous value)

Renderer code consuming `vrm.<bone>.q[xyzw]` must apply the quaternion rotation directly to the bone (e.g. via Three.js `bone.quaternion.set(qx, qy, qz, qw)`).

## endPose Compatibility

`endPose` entries targeting channels matching `/\.q[xyzw]$/` are rejected with a console warning. End-pose snapshots are not supported for quaternion channels.

## Validation

`isIdleClip()` in `validateSchema.ts` accepts both v1 and v2 tracks:
- v1: keyframes must have `{time: number, value: number}`
- v2: keyframes must have `{time, x, y, z, w}` all `number`; each quaternion must be unit-norm (`|norm - 1| ≤ 1e-3`)

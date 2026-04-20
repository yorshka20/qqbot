# vrma-to-clip

## Purpose

The qqbot avatar system treats the **bot process as the sole frame authority**: only the bot's
30Hz animation compiler is allowed to drive frame outputs. Allowing Three.js (or any renderer) to
play back a `.vrma` file at runtime would make the renderer the frame source — breaking this
invariant and tying the bot's logic to rendering infrastructure it shouldn't depend on.

The correct lever is **offline conversion**: sample the VRMA keyframes once, ahead of time, and
store the result as an `IdleClip` JSON that the compiler replays deterministically. This tool
performs that conversion. It reads a `.vrma` / `.glb` file, parses the embedded
`VRMC_vrm_animation` data via `@pixiv/three-vrm-animation`, samples every bone-rotation and
expression channel at 30Hz, and writes a JSON file that matches the `IdleClip` schema consumed by
`AnimationCompiler`.

---

## Usage

**Single file** (output defaults to same directory as input, `.json` extension):

```bash
bun run tools/vrma-to-clip/index.ts data/vrma-raw/wave.vrma
```

**Explicit output path:**

```bash
bun run tools/vrma-to-clip/index.ts data/vrma-raw/wave.vrma packages/avatar/assets/clips/vrm/wave.json
```

**Batch convert all VRMA files:**

```bash
for f in data/vrma-raw/*.vrma; do
  bun run tools/vrma-to-clip/index.ts "$f" "packages/avatar/assets/clips/vrm/$(basename "$f" .vrma).json"
done
```

Add `-q` / `--quiet` for single-line summary output suitable for CI logs.

---

## File layout convention

| Location | Purpose |
|---|---|
| `data/vrma-raw/` | Raw `.vrma` source files — **gitignored**, local dev machines only |
| `packages/avatar/assets/clips/vrm/` | Converted `.json` clips — **tracked in git** |

This tool writes to whatever output path the caller provides; it does **not** default to either
directory. You control the destination.

---

## Output schema

The output is an `IdleClip`:

```typescript
export interface IdleClip {
  id: string;
  duration: number;
  tracks: IdleClipTrack[];
}
export interface IdleClipTrack {
  channel: string;   // e.g. "vrm.leftUpperArm.x", "vrm.expression.happy", "vrm.root.x"
  easing?: EasingType; // not set by this tool — consumer defaults to easeInOutCubic
  keyframes: { time: number; value: number }[];
}
```

Channel naming:

- Bones: `vrm.<boneName>.<axis>` where `boneName` is a VRM 1.0 camelCase `VRMHumanBoneName`
  (e.g. `leftUpperArm`) and `axis` ∈ `{x, y, z}` (Euler XYZ decomposition in radians)
- Expressions: `vrm.expression.<name>` (e.g. `vrm.expression.happy`, `vrm.expression.aa`)
- Root motion: `vrm.root.x`, `vrm.root.z` (hips translation, Y ignored), `vrm.root.rotY`
  (hips Y-axis rotation via Euler YXZ decomposition)

Example (first 20 lines of `synthetic.vrma.glb` converted):

```json
{
  "id": "synthetic.vrma",
  "duration": 1,
  "tracks": [
    {
      "channel": "vrm.head.y",
      "keyframes": [
        { "time": 0, "value": 0 },
        { "time": 0.03333333333333333, "value": 0.05235987690693941 },
        { "time": 0.06666666666666667, "value": 0.10471975380399785 },
        { "time": 0.1, "value": 0.15707963068107542 },
        { "time": 0.13333333333333333, "value": 0.2094395075276239 },
        { "time": 0.16666666666666666, "value": 0.26179938433239625 },
        { "time": 0.2, "value": 0.3141592651889545 }
      ]
    }
  ]
}
```

Sampling details:
- 30Hz (dt = 1/30 s), `Math.floor(duration / dt) + 1` keyframes per track
- Bone quaternions → Euler XYZ via `THREE.Euler.setFromQuaternion(q, 'XYZ')`
- Static tracks are dropped: axis dropped if `max - min < 1e-5` rad
- Root motion suppressed if `max|dX| < 0.01 && max|dZ| < 0.01 && max|dRotY| < 0.01`

**VRM 0.x vs 1.0 note:** `@pixiv/three-vrm-animation` can retarget animations to both VRM 0.x
and 1.0 avatar targets. However, the `.vrma` format itself uses VRM 1.0 bone naming (camelCase,
e.g. `leftUpperArm`). This tool outputs VRM 1.0 channel names as-is and performs no 0.x↔1.0
conversion.

Consumer is implemented in ticket `[B 2/3] 2026-04-21-avatar-compiler-clip-path` (TBD), which adds `ActionMapEntry.kind: 'clip'` to the compiler.

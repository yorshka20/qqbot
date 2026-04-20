# @qqbot/avatar

Live2D avatar animation compiler, driver, and preview server for the qqbot framework.

---

## EndPose & Baseline

This section documents the `endPose` / `channelBaseline` / crossfade trio for action-map authors.

### `endPose`

An action-map entry may include an optional `endPose` array. When present, the compiler crossfades into this pose after the main animation (attack → sustain → release) completes, rather than releasing all channels back to zero.

```jsonc
"hand_on_hip": {
  "params": [
    { "channel": "arm.right", "targetValue": 5.5, "weight": 0.9 },
    { "channel": "body.x",   "targetValue": 0.06, "weight": 0.5 }
  ],
  "endPose": [
    { "channel": "arm.right", "value": 3.2, "weight": 0.8 },
    { "channel": "body.x",   "value": 0.03, "weight": 0.4 }
  ],
  "defaultDuration": 2000
}
```

**Key rules:**

- `endPose[].value` is **not** scaled by the animation's `intensity`. It is an absolute visual settling point — the avatar's physical resting state after the gesture, independent of how strongly it was performed.
- During the release phase the channel smoothly interpolates from its peak value toward `value * weight` (the settled position).
- After the animation is harvested the settled values are written into `channelBaseline` (see below).

### `holdMs`

Adding `"holdMs": N` extends the end-pose hold for `N` additional milliseconds before the animation is considered done and harvested. Useful for poses that should "stick" briefly (e.g. a pointing gesture that lingers before dropping).

```jsonc
"point_forward": {
  ...
  "endPose": [{ "channel": "arm.right", "value": 5.5, "weight": 0.9 }],
  "holdMs": 800
}
```

### `channelBaseline`

When an animation with an `endPose` is harvested, the compiler writes the settled values into a per-channel **baseline** map. While a channel has a non-zero baseline value:

- Its baseline contribution is added to the spring-damper input every tick, keeping the avatar in the settled pose even when no active animation is driving that channel.
- The spring state is **snapped** to the settled value on harvest so the channel never blinks back to zero between harvest and the next spring update.
- Baseline values **exponentially decay** back to zero over time (half-life controlled by `compiler.baselineHalfLifeMs`, default 45 s). This means a pose naturally fades out if no new animation reinforces it.

> The decay step runs **before** harvesting new animations each tick to avoid a one-tick double-count where the same settled value would come from both the old baseline and the newly harvested animation simultaneously.

### Crossfade

When a new animation starts on channels that are already being driven by an active animation, the compiler performs a **bidirectional crossfade**:

- The **old** animation fades out over `compiler.crossfadeMs` (default 250 ms).
- The **new** animation on those same channels fades **in** over the same window, starting from its own `startTime`.

This means there is no jump or pop — the two contributions sum to 1.0 across the crossfade window.

Crossfade only applies to **conflicting channels** (channels present in both animations). Non-conflicting channels in the old animation continue at full weight until they expire normally.

### Tunable parameters

Both `crossfadeMs` and `baselineHalfLifeMs` are exposed as live sliders in the HUD tuning panel under the **"Envelope & Crossfade"** section (`compiler:envelope`). Changes take effect on the next tick without restarting the compiler.

---

## Anticipation, Accompaniment, and Variants

These features layer on top of the ADSR + endPose + crossfade machinery from
[A 1/3] to add the "animation principles" that push the avatar away from a
mechanical feel: secondary motion leading the primary, correlated background
nudges, and variation between otherwise-identical repeats.

### Per-target timing (`leadMs` / `lagMs`)

Each `ParamTarget` can independently declare its envelope offset relative to
the enclosing animation's start/end:

- `leadMs: -100` means this channel begins its ADSR 100 ms **earlier** than
  the animation's nominal start (anticipation).
- `lagMs: +200` means this channel finishes its release 200 ms **after** the
  animation's nominal end (follow-through).

Offsets only affect this target's envelope window; they do NOT change
`anim.startTime` or `anim.endTime`. Both fields are silently clamped to
`[-1000, +1000]` ms when the action is resolved.

Example (inside `point_forward`, so the head starts turning 100 ms before the
arm extends):

```json
"point_forward": {
  "params": [
    { "channel": "arm.right", "targetValue": 9.0, "weight": 1.0 }
  ],
  "accompaniment": [
    { "channel": "head.yaw", "targetValue": 5.0, "weight": 0.4, "leadMs": -100 }
  ]
}
```

### Accompaniment

`accompaniment` is an optional array of `ParamTarget`s authored alongside
`params`. Semantically it reads as "every time this action fires, also nudge
these channels" — typical uses are micro head/body follow-through. It is
merged into the main `targets[]` after `params` at `resolveAction` time, so
it participates in intensity scaling and crossfade identically to primary
params.

`accompaniment` does **not** contribute to `endPose`: it is a transient
flourish, not a settled pose.

See `wave`, `nod`, and `point_forward` in
`packages/avatar/assets/default-action-map.json` for live examples.

### Variants

An action name may map to **either** a single `ActionMapEntry` (object) **or**
a non-empty `ActionMapEntry[]` array. When an array is present, each call to
`ActionMap.resolveAction()` picks one variant uniformly at random. Use this
for actions that repeat often (wave, nod, blink) to avoid uncanny-valley
identical repeats.

```json
"wave": [
  { "params": [...], "defaultDuration": 1800, "category": "movement" },
  { "params": [...], "defaultDuration": 2100 },
  { "params": [...], "defaultDuration": 1600 }
]
```

`listActions()` summarises a variant set by aggregating: channels are the
union across all variants (including accompaniment channels), `defaultDuration`
is the rounded average, and `category` / `description` come from the first
variant as the representative.

### Jitter

`AvatarService.enqueueTagAnimation()` applies per-call randomization to the
LLM-authored tag's duration and intensity before queueing it onto the
compiler:

- Duration: default ±15% (`durationJitter = 0.15`).
- Intensity: default ±10% (`intensityJitter = 0.10`), clamped to `[floor, 1]`
  where `intensityFloor = 0.1` by default.

Jitter is read from the compiler's effective override via
`compiler.getEffectiveJitter()` — runtime-tunable through the
`compiler:jitter` section (HUD Randomization panel). Set any axis to `0` to
disable jitter on that axis and get deterministic playback for the tuning
session.

Jitter is **not** applied to state-transition nodes routed through
`AvatarService.setActivity()` / `toStateNodes()` — those remain deterministic
so pose transitions stay predictable.

---

## Action Map Format

Action maps are plain JSON files with the following shape per entry:

```jsonc
"<action-name>": {
  "category": "emotion" | "movement" | "micro",  // optional; for HUD grouping
  "description": "One-line Chinese/English description for LLM prompt injection",
  "params": [
    { "channel": "<semantic-channel>", "targetValue": <number>, "weight": <0..1>, "oscillate"?: <cycles> }
  ],
  "defaultDuration": <ms>,
  "endPose"?: [ { "channel": "...", "value": <number>, "weight"?: <0..1> } ],
  "holdMs"?: <ms>
}
```

Semantic channel names (e.g. `head.yaw`, `mouth.smile`, `arm.right`) are renderer-agnostic. The driver adapter translates them to native parameter IDs (VTS tracking params, Cubism Live2D params, etc.).

---

## Configuration

```jsonc
"avatar": {
  "enabled": true,
  "compiler": {
    "fps": 60,
    "outputFps": 30,
    "crossfadeMs": 250,        // ms; crossfade duration for overlapping channels
    "baselineHalfLifeMs": 45000 // ms; half-life for endPose baseline decay
  }
}
```

See `config.example.jsonc` for the full annotated avatar config block.

---

## Clip Action Path

The avatar compiler supports two parallel action kinds: **envelope** (the ADSR
param-target path described above) and **clip** (keyframe-based VRM/channel
animation driven by a JSON file).

### ActionMapEntry with `kind: 'clip'`

```json
"formal_bow": {
  "kind": "clip",
  "category": "movement",
  "description": "正式鞠躬——表示尊敬或郑重问候",
  "clip": "clips/formal-bow.json",
  "defaultDuration": 1800,
  "endPose": [
    { "channel": "vrm.hips.x", "value": 0.0, "weight": 0.5 }
  ]
}
```

The `clip` field is a path relative to the action-map JSON file. At startup
`ActionMap.preloadClips()` loads and caches all clip files referenced by
`kind: 'clip'` entries.

### Clip schema

```json
{
  "id": "formal-bow",
  "duration": 1.8,
  "tracks": [
    {
      "channel": "vrm.hips.x",
      "easing": "easeInOutQuad",
      "keyframes": [
        { "time": 0.0, "value": 0.0 },
        { "time": 0.6, "value": 0.4 },
        { "time": 1.8, "value": 0.0 }
      ]
    }
  ]
}
```

- `duration`: clip length in seconds.
- `tracks[].channel`: semantic channel id (e.g. `vrm.hips.x`).
- `tracks[].easing`: optional easing type (defaults to `easeInOutCubic`).
- `tracks[].keyframes`: ascending-time `{ time, value }` pairs.

### Clip envelope semantics

When a clip action starts the compiler applies a linear fade-in (`attackMs`,
default **200 ms**) and fade-out (`releaseMs`, default **300 ms**). Both are
clamped to at most `duration * 0.5` so short clips never clip-envelope past the
midpoint. Intensity is a linear multiplier applied per-tick to the sampled
value.

Configure via `compiler.clipEnvelope` in `config.jsonc`:

```jsonc
"clipEnvelope": {
  "attackMs": 200,
  "releaseMs": 300
}
```

### Crossfade

Crossfade rules for clip actions are identical to envelope actions: when a new
animation starts on channels already driven by an active clip, the old clip
fades out over `crossfadeMs` while the new one fades in.

### Channel registries

Two separate channel registries exist:
- `CHANNELS` — Live2D/Cubism semantic channels (e.g. `head.yaw`, `arm.right`).
  Used by envelope-kind actions and the VTSDriver.
- `VRM_CHANNELS` — VRM humanoid bone rotation channels (e.g. `vrm.hips.x`,
  `vrm.rightUpperArm.z`). Used by clip-kind actions targeting the VRM renderer.

Both are exported from `packages/avatar/src/channels/index.ts`.

### Debug: `/clip/:name` preview route

The preview server exposes a debug endpoint:

```
GET http://localhost:8002/clip/<action-name>
```

Returns the first preloaded `IdleClip` JSON for the named action (404 if not a
clip action or unknown).

---

## Rich Tag Vocabulary

On top of the legacy `[LIVE2D: action=X, emotion=Y, intensity=Z]` tag,
the parser recognizes four orthogonal slot tags routed by
`TagAnimationStage` into distinct `AvatarService` entries:

| Tag | Example | Routes to | Notes |
|---|---|---|---|
| `[A:name@intensity]` | `[A:wave@0.8]` | `enqueueTagAnimation` | `@intensity` optional (default 1.0) |
| `[E:name@intensity]` | `[E:happy@0.7]` | `enqueueEmotion` | persists via `channelBaseline` until overridden |
| `[G:target]` | `[G:camera]`, `[G:0.3,-0.2]`, `[G:clear]` | `setGazeTarget` | named direction, point, or clear (natural gaze) |
| `[H:dur]` | `[H:short]` | (ctx-local) | `brief` / `short` / `long` scale the next `[A:...]` duration |

Legacy `[LIVE2D:]` tags remain fully supported; the parser also derives
a persistent `[E:emotion]` from any non-neutral emotion field so old
prompts get the new baseline-persistence behavior automatically.

See `prompts/avatar/partials/tag-spec.txt` for the LLM-facing spec.

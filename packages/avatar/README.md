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

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

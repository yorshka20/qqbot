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
- Baseline values **exponentially decay** back to zero over time (half-life controlled by `compiler.baselineHalfLifeMs`, default **3 s**). This means an envelope-kind gesture's endPose lingers briefly after release and then hands off back to the idle-clip posture. The earlier 45 s default was left over from a design without a competing absolute-pose idle layer; with the current loop-clip-owns-rest-pose model, shorter decays reduce cross-namespace contention.

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
`packages/avatar/assets/core-action-map.json` for live examples. The default
action map also merges a generated VRM index; see
[Default package action map](#default-package-action-map) under **Action Map Format** below.

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

## Model-Aware Handshake

The preview WebSocket supports an inbound `hello` message that lets the renderer
declare which model format it has loaded. The bot uses this to filter layers and
actions that are only meaningful for a specific renderer.

### `hello` message contract

```jsonc
// Renderer → bot, sent on WS open (or after a model hot-swap).
{ "type": "hello", "modelKind": "cubism" | "vrm" | null, "protocolVersion": 1 }
```

- `modelKind: "cubism"` — renderer has a Live2D Cubism model loaded.
- `modelKind: "vrm"` — renderer has a VRM/three-vrm model loaded.
- `modelKind: null` — renderer is connected but has not loaded any model yet.
- `protocolVersion` must be `1` for this revision.

Old renderers that never send `hello` leave the compiler in the default state
(`currentModelKind = null`), which disables filtering — fully backward-compatible.

### `currentModelKind` — last hello wins

The compiler tracks a **single global** `currentModelKind` value. Every time a
`hello` message arrives the value is overwritten. There is no per-client state:
if multiple WS clients connect and send different `hello` declarations, the last
one wins. In practice only one renderer connects at a time.

### Layer filtering: `AnimationLayer.modelSupport`

Each layer may declare which model kinds it is compatible with via the optional
`modelSupport` readonly array:

```ts
readonly modelSupport?: readonly ModelKind[];
// e.g. ['vrm'] — only runs when modelKind === 'vrm'
//      ['cubism', 'vrm'] — runs for either
//      absent (undefined) — runs for both (backward-compat default)
```

Filtering is applied by `LayerManager.sample()` each tick:
- If `currentModelKind` is **null**: no filtering, all layers run.
- If `currentModelKind` is non-null: layers where `modelSupport` is defined
  and **does not include** `currentModelKind` are skipped entirely (both scalar
  and quat outputs). Layers that do not declare `modelSupport` always run.

### Action-map filtering: `ActionMapEntry.modelSupport`

Action-map entries (both `kind:'envelope'` and `kind:'clip'`) accept an optional
`modelSupport` field:

```jsonc
"formal_bow_vrm": {
  "kind": "clip",
  "modelSupport": "vrm",   // "cubism" | "vrm" | "both"
  ...
}
```

- `"cubism"` / `"vrm"` — entry is only resolved when `currentModelKind` matches.
- `"both"` / absent — entry is compatible with any model kind.

Filtering applies in `ActionMap.resolveAction()` (action queue resolution) and
`ActionMap.listActions()` (the `/action-map` HTTP endpoint and `[A:]` tag
vocabulary). When `currentModelKind` is null, all entries are returned.

### HUD `/action-map` narrowing

The `GET /action-map` endpoint calls `AnimationCompiler.listActions()` which
internally calls `ActionMap.listActions(currentModelKind)`. When the renderer
has sent a `hello` with a non-null `modelKind`, the endpoint returns only the
actions compatible with that model. The HUD trigger list therefore narrows
automatically to the renderer's actual capabilities without any manual
configuration.

### VRM Rest Pose (data layer)

The compiler loads an authoritative resting pose from
`packages/avatar/assets/vrm-rest-pose.json` at construction time. This is the skeleton
baseline used when no continuous layer currently covers a bone.

**Where the data lives:** `packages/avatar/assets/vrm-rest-pose.json`
(schema `vrm-rest-pose.v1`, rotation order `XYZ`, 56 VRM humanoid bones).

**How it is generated:** run
```bash
bun run packages/avatar/scripts/extract-rest-pose.ts
```
The script reads frame 0 of `idle_general_01.json` and writes
`packages/avatar/assets/vrm-rest-pose.json`. Bones absent from the source clip default
to `{0, 0, 0}` euler. The script and JSON are both checked in.

**Why it exists:** eliminates the identity-quat T-pose fallback that previously
caused bones to snap to T-pose at clip release tail and during clip-to-clip
handoffs. Prior to this change, any bone not covered by an active continuous
layer fell back to identity quaternion (`0, 0, 0, 1`) — which is T-pose in
the VRM spec. Identity quat is **no longer a valid runtime fallback** in production.

**How it interacts with `IdleMotionLayer`:** `IdleMotionLayer` provides additive
idle dynamics (breathing, micro-swaying) on top of the rest pose. Bones outside
the idle clip's coverage no longer fall to T-pose because the rest pose JSON
covers all 56 VRM humanoid bones. The two mechanisms are complementary: the
JSON provides the static baseline, and the idle clip provides continuous motion.

**How to extend:** regenerate `packages/avatar/assets/vrm-rest-pose.json` via the script
when the source idle clip changes. If a new VRM model has different resting bone
angles, update the source clip or regenerate the JSON accordingly.

---

## Action Map Format

### Default package action map

When `avatar.actionMap.path` is **not** set, `ActionMap` loads two JSON files from `packages/avatar/assets/` and merges them:

| File | Role |
|------|------|
| `vrm-extend-action-map.json` | **Generated** — do not hand-edit. One `kind: "clip"` entry per file under `assets/clips/vrm/*.json`, except `test-fixture.json`. Action names are `vrm_<filename-slug>` (non-alphanumeric characters in the base name are folded to `_`, e.g. `VRMA_01.json` → `vrm_VRMA_01`, `Take 001.json` → `vrm_Take_001`). Durations are taken from each clip’s `duration` field. |
| `core-action-map.json` | **Hand-authored** — envelope actions, Cubism-only gestures, curated VRM clip names (`greet`, `formal_bow`, …), and any entry that should override a generated one. |

Merge order is **extend first, then core** (`mergeActionMapPayloads`): **core wins on the same key**, so you can override or mask a generated action by redefining it in `core-action-map.json`.

Clip paths in both files use the same base directory: the folder that contains the JSON (typically `assets/`), e.g. `"clip": "clips/vrm/VRMA_01.json"`.

**Regenerate** the extend file after adding, removing, or renaming clip JSONs under `assets/clips/vrm/`:

```bash
cd packages/avatar && bun run gen:vrm-extend
```

`default-action-map.json` was **removed**; the package default is this two-file merge. If you set `avatar.actionMap.path` in config, that path points to a **single** map file: it is loaded **as-is** with no merge (used for tests or a fully custom map).

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
    "outputFps": 60,
    "crossfadeMs": 250,         // ms; crossfade duration for overlapping channels
    "baselineHalfLifeMs": 3000,  // ms; half-life for endPose baseline decay (handoff to idle-clip posture)
    "idle": {
      "loopClipActionName": "idle_standing" // VRM idle clip (sole source of rest pose)
    },
    "walk": {
      "cycleClipActionName": "walk_forward" // optional; kind:'clip' action for leg-bone overlay while walking
    }
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

The `clip` field is a path relative to the **assets directory** that holds the
action-map JSON (for the default merge, that is the directory of
`core-action-map.json` / `vrm-extend-action-map.json`, i.e. `packages/avatar/assets/`). At
startup `ActionMap.preloadClips()` loads and caches all clip files referenced by
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

## VRM Idle Loop

VRM 1.0's normalized humanoid defines T-pose as identity on every bone. The
compiler's rest pose JSON (`packages/avatar/assets/vrm-rest-pose.json`) provides the
authoritative static baseline for all bones, eliminating identity-quat T-pose
fallbacks. On top of this baseline, `IdleMotionLayer` provides **additive idle
dynamics** — continuous motion (breathing, swaying, subtle micro-motions) that
animates the avatar while in the resting state. `IdleMotionLayer` is therefore
an **additive motion layer**, not the sole source of resting posture.

A VRM avatar setup still benefits from a loop clip configured via
`idle.loopClipActionName`; without one, idle motion channels (hips sway,
spine breathing, etc.) simply stop being emitted and only the static rest pose
is held. The renderer falls back to the last observed value (or rest pose)
rather than T-pose.

### `idle.loopClipActionName`: continuous VRM idle clip

When `CompilerConfig.idle.loopClipActionName` names a clip action, the
`IdleMotionLayer` switches from its legacy gap-based one-shot pool into
**loop mode**: it plays the named clip continuously, wrapping time back to
`t=0` when `elapsed >= clip.duration`.

```jsonc
"compiler": {
  "idle": { "loopClipActionName": "idle_standing" }
}
```

The clip is resolved through the bot's action-map at `AvatarService`
initialization, so the referenced action must exist as a `kind: 'clip'`
entry. If resolution fails, the layer logs a warning and stays in gap mode.

### Freeze-on-gate-exit semantics

Loop mode is **not** gated by `isTrulyIdle`. When the bot leaves the truly-
idle state (speaking / listening / thinking), the layer does not stop
emitting — it freezes the clip at the current elapsed time and re-emits that
same frame every tick. When the gate re-opens, the timeline is rebased so
the clip continues forward from the frozen frame rather than jumping back
to `t=0`. This keeps the posture visually continuous across state
transitions: a hand held up at the V-sign peak stays up through speaking,
rather than being pulled down to humanoid identity.

This is a deliberate asymmetry with other ambient layers (breath, blink,
perlin, gaze), which ARE scaled by `ambientGain` because they emit deltas /
micro-motions. The loop clip emits **absolute** posture values, and scaling
those by 0.3 would produce an unintended T-pose blend rather than a subtle
dimming — so the clip is exempt from `ambientGain` modulation and bypasses
the `isTrulyIdle` gate entirely.

### Per-channel exclusion for idle clip

The idle clip holds **absolute** channel values. If an active action also
targets a clip channel, naive additive mixing would produce garbage
(`idle + action` on a shared bone). To prevent this, every layer's
`sample(nowMs, activity, activeChannels?)` receives the set of channels
active discrete animations will write this tick — `IdleMotionLayer` drops
contributions for channels in that set.

Result: a `wave` action can play on `vrm.rightUpperArm.z` while the idle
clip continues driving spine breathing, left arm, legs, etc. —
simultaneously, no collision.

---

## WalkingLayer — Walk-Cycle Clip

`WalkingLayer` owns `vrm.root.x`, `vrm.root.z`, and `vrm.root.rotY` while a
walk is pending. Without a walk-cycle clip the layer emits root motion only —
the avatar "slides" to the destination with no leg animation. An optional clip
can be injected to add bone-channel leg cycling on top.

### `compiler.walk.cycleClipActionName`

```jsonc
"compiler": {
  "walk": {
    "cycleClipActionName": "walk_forward"   // must be a kind:'clip' action in the action-map
  }
}
```

At `AvatarService.start()` the named action is resolved through the compiler's
action-map. If it resolves to a clip, `WalkingLayer.setWalkCycleClip(clip,
authoredSpeedMps)` is called once. If the name is absent or unresolved, the
layer stays in slide mode and a warning is logged — no exception is thrown.

### Clip contribution semantics

- **Active only while walking**: the clip is sampled only when `WalkingLayer`
  has a pending walk target. When idle the layer emits `{}` (renderer keeps the
  last pose).
- **Bone channels only**: `vrm.root.*` tracks in the clip are filtered out by
  `sampleClip`. `WalkingLayer` is the sole owner of root motion; the clip
  contributes leg/arm bones additively.
- **Playback rate follows actual speed**: the clip's timeline advances at
  `dtMs × rateFactor` where
  `rateFactor = clamp(actualStepMps / authoredSpeedMps, 0.2, 2.0)`. When the
  avatar moves slower than the authored speed the cycle slows down
  proportionally; faster walking speeds it up. The `[0.2, 2.0]` clamp prevents
  extreme stretching during start/stop ramps.
- **Continuous loop**: elapsed time wraps at `clip.duration`, producing a
  seamless gait cycle for any walk distance. The timeline resets to zero when a
  new `walkTo()` call begins.

### Degradation to slide mode

When `cycleClipActionName` is omitted or the named action is not found in the
action-map, `WalkingLayer` operates in slide mode: root channels are still
emitted and arrival/progress callbacks still fire, but no bone overlay is
produced. This lets the system function before walk-cycle assets are available.

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

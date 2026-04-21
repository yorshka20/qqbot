# Avatar

## Current Architecture

- `AvatarService` is the orchestrator. It initializes `AnimationCompiler`, `ActivityTracker`, optional `VTSDriver`, optional `PreviewServer`, and optional `SpeechService`.
- The compiler tick is consumer-gated. It runs only when there is at least one downstream consumer (`VTS` or a preview client), so idle CPU spin is avoided.
- `PreviewServer` binds `0.0.0.0:8002`, caches the latest status, and serves `/`, `/health`, `/action-map`, and `/clip/:name`. WebSocket client messages now include `trigger`, `speak`, `ambient-audio`, `tunable-params-request`, and `tunable-param-set`.
- `frame` and `status` remain the core outbound WS messages; `status` now carries `pose`, `ambientGain`, `channelBaseline?`, and `activeAnimationDetails?`.

## Runtime Model

- `AvatarActivity` is the runtime activity contract. It feeds the compiler and layers; the bot-facing pose vocabulary is still `idle` / `listening` / `thinking` / `speaking` / `reacting`.
- `Live2DAvatarPlugin` maps hook events to `AvatarActivity` transitions and strips `[LIVE2D: ...]` tags before the reply is sent. Reply trigger ownership stays in `MessageTriggerPlugin`.
- `PromptAssemblyStage` injects the `avatar.emotion-system` fragment only when `AvatarService` is registered.

## Compiler

- `AnimationCompiler` now has two action paths:
  - `kind: "envelope"`: legacy ADSR path with per-target timing, crossfade, endPose harvesting, and baseline decay.
  - `kind: "clip"`: preloaded `IdleClip` path that samples JSON clips per tick with a short attack/release envelope.
- `ActionMap` preloads clip JSON at startup, drops broken clip entries, and exposes `getClipByActionName()` for the preview debug route.
- `ActiveAnimation` is a discriminated union. `PreviewStatus.activeAnimationDetails[].kind` mirrors whether the action is envelope or clip.
- `smoothingFactor` is deprecated and ignored by the spring-damper tick. Spring tuning is per-channel and exposed through `compiler:spring-damper`.

## Layers

- `AudioEnvelopeLayer` is ephemeral and per-utterance. It always emits `mouth.open`, and only emits `body.z`, `eye.open.left`, `eye.open.right`, and `brow` when the derived excite value is above threshold.
- `AmbientAudioLayer` is long-lived and driven by renderer-machine ambient RMS. It is separate from lip-sync and is registered in the default layer stack.
- `IdleMotionLayer`, `BreathLayer`, `AutoBlinkLayer`, and `EyeGazeLayer` remain the default continuous layer set.

## Channels And Clip Pipeline

- Cubism channels live in `packages/avatar/src/channels/registry.ts`.
- VRM channels live in `packages/avatar/src/channels/vrm-registry.ts` and use the `vrm.*` namespace.
- The offline VRMA tool in `tools/vrma-to-clip/` converts `.vrma` files into `IdleClip` JSON with 30Hz sampling, quaternion-to-Euler axis split, and root channels `vrm.root.{x,z,rotY}`.
- Root motion ignores Y translation. Static clip filtering uses the `1e-5` rad threshold; root suppression uses the `0.01` threshold.

## Tags And Actions

- LLM tags still use `[LIVE2D: emotion=X, action=Y, intensity=Z]`.
- Action lists are discovered from `ActionMap.listActions()` instead of hardcoded UI tables.
- The default action map now supports both demo envelope actions and clip actions.

## Invariants

- Avatar code does not import bot code.
- `node:events` is used for EventEmitter-based compiler and driver layers.
- New functionality stays behind tickets; shared utilities are reused instead of copied.

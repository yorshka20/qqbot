import { singleton } from 'tsyringe';
import { AnimationCompiler } from './compiler/AnimationCompiler';
import { isEmotionChannel } from './compiler/emotion-channels';
import type { AmbientAudioLayer } from './compiler/layers/AmbientAudioLayer';
import { IdleMotionLayer } from './compiler/layers/IdleMotionLayer';
import { WalkingLayer } from './compiler/layers/WalkingLayer';
import type { ActionSummary, StateNode } from './compiler/types';
import { mergeAvatarConfig } from './config';
import { VTSDriver } from './drivers/VTSDriver';
import {
  type ActionCategory,
  IDENTITY_MODULATION,
  type MindModulation,
  type MindModulationProvider,
  sanitizeScale,
} from './mind/types';
import { PreviewServer } from './preview/PreviewServer';
import type { RendererCapabilities, WalkCommandData } from './preview/types';
import { SpeechService } from './SpeechService';
import { ActivityTracker } from './state/IdleStateMachine';
import { type AvatarActivityPatch, DEFAULT_ACTIVITY, type StateNodeOutput } from './state/types';
import type { FaceTarget, GazeTarget, WalkToTarget } from './tags';
import type { TTSManager } from './tts/TTSManager';
import type { TTSProvider } from './tts/TTSProvider';
import type { AvatarConfig } from './types';
import { DEFAULT_AVATAR_CONFIG } from './types';
import { logger } from './utils/logger';

@singleton()
export class AvatarService {
  private config: AvatarConfig = DEFAULT_AVATAR_CONFIG;
  private compiler: AnimationCompiler | null = null;
  private stateMachine: ActivityTracker | null = null;
  private driver: VTSDriver | null = null;
  private previewServer: PreviewServer | null = null;
  private started = false;
  private frameCount = 0;
  private lastFpsSampleAt = 0;
  private measuredFps = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Running count of downstream frame consumers — `1` for VTS-connected +
   * `N` for active preview WebSocket clients. The compiler tick is paused
   * whenever this hits zero so we don't burn CPU sampling layers with
   * nothing to render.
   */
  private consumerCount = 0;
  private speechService?: SpeechService;
  /**
   * Optional mind-system modulation provider. When set via
   * `setMindModulationProvider`, it is consulted on every
   * `enqueueTagAnimation` call to apply persona-driven intensity / duration
   * scaling before the compiler's random jitter. Unset → identity (no
   * modulation), preserving pre-Phase-1 behaviour.
   */
  private modulationProvider?: MindModulationProvider;

  // TODO(capability-gating): use connectedCapabilities to gate compiler channel
  // emission per connection — e.g. skip unsupported channels or custom morph
  // targets that the loaded model does not expose. Requires routing frame output
  // per-socket rather than broadcasting the same frame to all clients.
  private readonly connectedCapabilities = new Map<
    WebSocket,
    {
      caps: RendererCapabilities;
      receivedAt: Date;
    }
  >();

  /**
   * Merge + apply the raw (JSONC-parsed) avatar config and initialize all
   * subsystems. Must be called before `start()`. No network I/O occurs here.
   *
   * Accepts the raw blob from `ConfigManager.getAvatarConfig()` so hosts
   * don't have to know the schema — the merge happens in `mergeAvatarConfig`
   * next door. `undefined` is treated as "no avatar section" and leaves the
   * service disabled.
   */
  async initialize(rawConfig: Record<string, unknown> | undefined, ttsManager?: TTSManager): Promise<void> {
    const config = mergeAvatarConfig(rawConfig);
    this.config = config;

    if (!config.enabled) {
      logger.debug('[AvatarService] Disabled, skipping initialization');
      return;
    }

    this.compiler = new AnimationCompiler(config.compiler, config.actionMap?.path);
    this.stateMachine = new ActivityTracker();

    // VTSDriver is optional: when vts.enabled=false, we run with only the
    // compiler + preview server. Frames are still broadcast to preview WS
    // clients (e.g. the self-hosted Cubism renderer), just not injected
    // into VTube Studio.
    if (config.vts.enabled) {
      this.driver = new VTSDriver(config.vts);
    } else {
      logger.info(
        '[AvatarService] VTS driver disabled (config.vts.enabled=false); frames will only reach preview clients',
      );
    }

    const ambientAudioLayer = this.compiler.getLayer('ambient-audio') as AmbientAudioLayer | undefined;
    if (config.preview.enabled) {
      this.previewServer = this.createPreviewServer(config.preview, ambientAudioLayer);
    }

    // SpeechService hooks into the bot-wide TTSManager built in bootstrap —
    // we don't construct providers here. `getDefault()` returns null if the
    // default is missing or unavailable (e.g. apiKey empty, endpoint blank),
    // so we refuse to enable speech without logging a reason.
    if (config.speech.enabled) {
      const provider = ttsManager?.getDefault();
      if (!provider) {
        logger.info('[AvatarService] speech.enabled=true but no usable TTS provider registered; SpeechService skipped');
      } else {
        this.speechService = this.createSpeechService(provider, config.speech);
        logger.debug(`[AvatarService] SpeechService initialized with provider="${provider.name}"`);
      }
    }

    logger.debug('[AvatarService] Initialized', { enabled: config.enabled });
  }

  /**
   * HTTP + WebSocket preview server; HUD / renderer callbacks below.
   *
   * - `onSpeak`: HUD “speak this text” bypasses the LLM; same `SpeechService`
   *   entry as `Live2DAvatarPlugin` (hasConsumer / provider gating applies).
   * - `onAmbientAudio`: renderer WS RMS → `AmbientAudioLayer.updateRms`.
   * - Walk: {@link handlePreviewWalkCommand} (rejects → `WalkInterruptedError` are ignored).
   */
  private createPreviewServer(preview: AvatarConfig['preview'], ambient: AmbientAudioLayer | undefined): PreviewServer {
    return new PreviewServer(preview, {
      onTrigger: (data) =>
        this.enqueueTagAnimation({
          action: data.action,
          emotion: data.emotion ?? 'neutral',
          intensity: data.intensity ?? 1.0,
        }),
      onClientCountChange: (count) => this.handlePreviewClientCount(count),
      getActionList: () => this.compiler?.listActions() ?? [],
      onSpeak: (data) => this.speak(data.text),
      onAmbientAudio: (data) => ambient?.updateRms(data.rms, data.tMs),
      onTunableParamsRequest: () => this.compiler?.listTunableParams() ?? [],
      onTunableParamSet: ({ sectionId, paramId, value }) => {
        this.compiler?.setTunableParam(sectionId, paramId, value);
      },
      getClipByActionName: (name) => this.compiler?.getClipByActionName(name) ?? null,
      onModelKindChange: (kind) => {
        this.compiler?.setCurrentModelKind(kind);
        logger.info(`[AvatarService] currentModelKind -> ${kind}`);
      },
      onCapabilities: (caps, ws) => {
        this.connectedCapabilities.set(ws, { caps, receivedAt: new Date() });
        logger.info(
          `[AvatarService] renderer capabilities received — kind=${caps.modelId.kind} slug=${caps.modelId.slug} presets=${caps.expressions.length} custom=${caps.customExpressions.length} channels=${caps.supportedChannels.length}`,
        );
      },
      onConnectionClosed: (ws) => {
        this.connectedCapabilities.delete(ws);
      },
      getConnectedCapabilities: () => this.listConnectedCapabilities(),
      onWalkCommand: (data) => this.handlePreviewWalkCommand(data),
    });
  }

  /**
   * Wire {@link SpeechService} to the bot: see that class’s constructor JSDoc
   * for the meaning of each dependency. Here we point callbacks at
   * `previewServer` (if any), `consumerCount`, and `AnimationCompiler` layers.
   */
  private createSpeechService(provider: TTSProvider, speech: AvatarConfig['speech']): SpeechService {
    return new SpeechService(
      provider,
      (msg) => this.previewServer?.broadcastAudio(msg), // full utterance → preview `audio` WS
      () => this.hasConsumer(), // gate: VTS and/or at least one preview client
      (layer) => this.compiler?.registerLayer(layer), // per-utterance `AudioEnvelopeLayer`
      (id) => this.compiler?.unregisterLayer(id), // drop layer after utterance
      undefined, // clock: default `Date.now` (see `SpeechService` default)
      speech.utteranceGapMs, // from avatar config: min gap between starts
      speech.exportTtsWavDir, // optional debug WAV dumps
      (msg) => this.previewServer?.broadcastAudioChunk(msg), // streaming path → `audio-chunk` WS
    );
  }

  /**
   * HUD walk intents → WalkingLayer. Supersedes resolve as `WalkInterruptedError`;
   * those are ignored so fire-and-forget WebSocket delivery never becomes an
   * unhandled rejection.
   */
  private handlePreviewWalkCommand(data: WalkCommandData): void {
    const run = (p: Promise<void>, label: string): void => {
      p.catch((err: unknown) => {
        const interrupted = err instanceof Error && err.name === 'WalkInterruptedError';
        if (interrupted) return;
        logger.warn(`[AvatarService] walk-command '${label}' failed: ${(err as Error)?.message ?? err}`);
      });
    };
    switch (data.kind) {
      case 'forward':
        run(this.walkForward(data.meters), 'forward');
        return;
      case 'strafe':
        run(this.strafe(data.meters), 'strafe');
        return;
      case 'turn':
        run(this.turn(data.radians), 'turn');
        return;
      case 'orbit':
        run(this.orbit(data), 'orbit');
        return;
      case 'to':
        run(this.walkTo(data.x, data.z, data.face), 'to');
        return;
      case 'stop':
        this.stopMotion();
    }
  }

  /** True if the avatar system is configured to run (post-initialize). */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Start the avatar system: wire subsystem events, connect driver,
   * start compiler/state-machine, and launch the preview server if configured.
   * Idempotent — safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (!this.config.enabled) {
      logger.debug('[AvatarService] Disabled, skipping start');
      return;
    }
    if (!this.compiler || !this.stateMachine) {
      logger.warn('[AvatarService] start() called before initialize() — skipping');
      return;
    }

    // Wire compiled frames → driver (fire-and-forget) + preview broadcast
    this.compiler.on('frame', (frame) => {
      this.driver?.sendFrame(frame.params).catch(() => {});
      this.previewServer?.broadcastFrame({ timestamp: frame.timestamp, params: frame.params });
      this.frameCount += 1;
    });

    // Driver emits 'error' events on transport failures (VTS not reachable,
    // WS drop, auth fail). EventEmitter crashes the process if no listener,
    // so we attach a non-fatal log sink. The try/catch around connect()
    // only catches the connect() promise rejection, not async 'error'
    // emissions that happen later during the session.
    if (this.driver) {
      this.driver.on('error', (err: Error) => {
        logger.warn('[AvatarService] Driver error (non-fatal):', err.message || err);
      });
      this.driver.on('connected', () => this.addConsumer('vts'));
      this.driver.on('disconnected', () => {
        logger.warn('[AvatarService] Driver disconnected; will attempt reconnect');
        this.removeConsumer('vts');
      });
    }

    // Continuous stack is in {@link AnimationCompiler}'s {@link LayerManager}
    // (see `registerContinuousStack` in the compiler constructor). Wire idle /
    // walk cycle clips from the action-map.
    const idleActionName = this.config.compiler.idle?.loopClipActionName;
    if (idleActionName) {
      const idleLayer = this.compiler.getLayer('idle-motion');
      const clip = this.compiler.getClipByActionName(idleActionName);
      if (idleLayer instanceof IdleMotionLayer && clip) {
        idleLayer.setLoopClip(clip);
        logger.info(
          `[AvatarService] IdleMotionLayer loop mode enabled with clip "${idleActionName}" (${clip.duration.toFixed(2)}s)`,
        );
      } else {
        logger.warn(
          `[AvatarService] idle.loopClipActionName="${idleActionName}" did not resolve to a clip; idle layer stays in gap mode`,
        );
      }
    }

    const walkCycleName = this.config.compiler.walk?.cycleClipActionName;
    if (walkCycleName) {
      const walkingLayer = this.compiler.getLayer('walking');
      const walkClip = this.compiler.getClipByActionName(walkCycleName);
      if (walkingLayer instanceof WalkingLayer && walkClip) {
        walkingLayer.setWalkCycleClip(walkClip);
        logger.info(
          `[AvatarService] WalkingLayer cycle clip enabled with "${walkCycleName}" (${walkClip.duration.toFixed(2)}s)`,
        );
      } else {
        logger.warn(
          `[AvatarService] walk.cycleClipActionName="${walkCycleName}" did not resolve to a clip; walking layer stays in slide mode`,
        );
      }
    }

    // NOTE: we deliberately do NOT call `compiler.start()` here. The tick
    // loop is gated on `consumerCount > 0` — an active VTS connection or at
    // least one preview WebSocket client. `addConsumer()` resumes it;
    // `removeConsumer()` pauses when the last consumer leaves.
    this.stateMachine.start();

    if (this.previewServer) {
      await this.previewServer.start();
      logger.info(`[AvatarService] Preview server started on ${this.config.preview.host}:${this.config.preview.port}`);
      this.startStatusBroadcast();
    }

    // Connect to VTubeStudio (non-fatal: bot works without avatar driver).
    // The driver's `connected` event (wired above) will bump the consumer
    // count and resume the compiler if this connect succeeds.
    if (this.driver) {
      try {
        await this.driver.connect();
      } catch (err) {
        logger.warn('[AvatarService] Driver failed to connect (non-fatal):', err);
      }
    }

    // Enter neutral pose + full ambient. If no consumer has arrived yet the
    // compiler stays paused; any transition nodes sit in the queue and will
    // play cleanly once the tick resumes.
    this.setActivity(DEFAULT_ACTIVITY);

    this.started = true;
    logger.info('[AvatarService] Started (compiler paused until first consumer)');
  }

  /**
   * Register a frame consumer (VTS driver connection, preview WS client).
   * Resumes the compiler tick on the 0→1 transition. Tagged for debug
   * logging — `vts` vs `preview` makes the lifecycle trace readable.
   */
  private addConsumer(source: 'vts' | 'preview'): void {
    this.consumerCount += 1;
    if (this.consumerCount === 1) {
      this.compiler?.resume();
      logger.info(`[AvatarService] Frame pipeline resumed (first consumer: ${source})`);
    }
  }

  /** Pair of `addConsumer`. Pauses the compiler when the count hits 0. */
  private removeConsumer(source: 'vts' | 'preview'): void {
    this.consumerCount = Math.max(0, this.consumerCount - 1);
    if (this.consumerCount === 0) {
      this.compiler?.pause();
      logger.info(`[AvatarService] Frame pipeline paused (last consumer left: ${source})`);
    }
  }

  /**
   * PreviewServer's WS open/close callback. Translates absolute client
   * counts into the delta-based `(in|de)crementConsumers` calls.
   */
  private handlePreviewClientCount(count: number): void {
    // Reconcile against our tracked preview-consumer portion. The driver
    // portion is handled separately by VTS events.
    const current = Math.max(0, this.consumerCount - (this.driver?.isConnected() ? 1 : 0));
    logger.info(
      `[AvatarService] preview client count changed — ws=${count} currentPreviewConsumers=${current} totalConsumers=${this.consumerCount} ticking=${this.compiler?.isTicking() ?? false}`,
    );
    if (count > current) {
      for (let i = 0; i < count - current; i++) this.addConsumer('preview');
    } else if (count < current) {
      for (let i = 0; i < current - count; i++) this.removeConsumer('preview');
    }
  }

  /**
   * Stop the avatar system and release all resources.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    this.stateMachine?.stop();
    this.compiler?.stop();

    if (this.driver?.isConnected()) {
      await this.driver.disconnect();
    }

    if (this.previewServer) {
      await this.previewServer.stop();
    }

    this.started = false;
    logger.info('[AvatarService] Stopped');
  }

  /**
   * Broadcast status to preview clients every 1s. FPS is computed by
   * counting emitted frames within the sample window; state and counters
   * come from the state machine and compiler respectively.
   */
  private startStatusBroadcast(): void {
    if (!this.previewServer || !this.stateMachine || !this.compiler) return;
    this.lastFpsSampleAt = Date.now();
    this.frameCount = 0;
    this.statusTimer = setInterval(() => {
      if (!this.previewServer || !this.stateMachine || !this.compiler) return;
      const now = Date.now();
      const elapsed = (now - this.lastFpsSampleAt) / 1000;
      this.measuredFps = elapsed > 0 ? Math.round(this.frameCount / elapsed) : 0;
      this.frameCount = 0;
      this.lastFpsSampleAt = now;
      const activity = this.stateMachine.current;
      const walkingLayer = this.getWalkingLayer();
      this.previewServer.updateStatus({
        pose: activity.pose,
        ambientGain: activity.ambientGain,
        fps: this.measuredFps,
        activeAnimations: this.compiler.getActiveAnimationCount(),
        queueLength: this.compiler.getQueueLength(),
        channelBaseline: this.compiler.getChannelBaselineSnapshot(),
        activeAnimationDetails: this.compiler.getActiveAnimationDetails(),
        // Authoritative pose broadcast so HUDs can display without replicating
        // bot state via frame params. Absent when no WalkingLayer (cubism).
        rootPosition: walkingLayer?.getPosition(),
      });
    }, 1000);
  }

  /**
   * Apply a partial activity update — `{ ambientGain?, pose? }`. Fields
   * omitted from the patch keep their previous value. Propagates to:
   *   - `compiler.setActivity` so the next tick uses the new activity
   *   - `stateMachine.update` which returns transition nodes for any pose
   *     edge (neutral→listening→thinking etc.); those are enqueued onto the
   *     compiler so the authored pose animation plays.
   *
   * Replaces the old `transition(state)` API — callers now express which
   * axis they're moving, not a single conflated enum.
   */
  setActivity(patch: AvatarActivityPatch): void {
    if (!this.stateMachine || !this.compiler) return;
    const nodes = this.stateMachine.update(patch);
    this.compiler.setActivity(this.stateMachine.current);
    if (nodes.length > 0) {
      this.compiler.enqueue(toStateNodes(nodes));
    }
  }

  /**
   * Register (or clear) the mind-system modulation provider. Called by the
   * bot-side mind bootstrap when mind is enabled. Avatar never imports mind
   * directly — passing `undefined` restores identity-modulation behaviour.
   */
  setMindModulationProvider(provider: MindModulationProvider | undefined): void {
    this.modulationProvider = provider;
    logger.info(`[AvatarService] MindModulationProvider ${provider ? 'registered' : 'cleared'}`);
  }

  /** Read-only snapshot of the current modulation for debug / HUD surfaces. */
  getCurrentMindModulation(): MindModulation {
    return this.modulationProvider?.getModulation() ?? IDENTITY_MODULATION;
  }

  /**
   * Queue a single LLM-authored action animation onto the compiler.
   * Duration defaults to the action-map's registered value, or 1500ms if
   * the action is unknown (the compiler will silently drop it in that case).
   *
   * Pipeline (inside this method):
   *   base → persona modulation → jitter → compiler
   * Modulation is deterministic and reflects the current mind state;
   * jitter is random and sits on top so two calls with the same state
   * still produce slight variation.
   */
  enqueueTagAnimation(tag: { emotion: string; action: string; intensity: number; durationOverrideMs?: number }): void {
    if (!this.compiler) {
      logger.warn(`[AvatarService] enqueueTagAnimation dropped (no compiler) | action=${tag.action}`);
      return;
    }
    const registered = this.compiler.getActionDuration(tag.action);
    // When durationOverrideMs is provided (e.g. from a [H:...] hold tag),
    // it replaces the action-map's registered duration as the jitter base.
    const baseDuration = tag.durationOverrideMs ?? registered ?? 1500;

    // ─── Persona modulation (deterministic) ─────────────────────────────
    const category = this.compiler.getActionCategory(tag.action) as ActionCategory | undefined;
    const modulation =
      this.modulationProvider?.getModulation({
        actionName: tag.action,
        category,
      }) ?? IDENTITY_MODULATION;

    const speedScale = sanitizeScale(modulation.timing.speedScale);
    // Local divide-by-zero guard: speedScale sanitizes to ≥0, but duration
    // division needs a positive floor to avoid Infinity when a persona
    // genuinely emits 0 (nonsensical but not our problem to crash on).
    const speedDivisor = Math.max(0.1, speedScale);
    const durationBias = Number.isFinite(modulation.timing.durationBias) ? (modulation.timing.durationBias ?? 0) : 0;
    const modulatedDuration = baseDuration / speedDivisor + durationBias;

    const intensityScale = sanitizeScale(modulation.amplitude.intensityScale);
    const categoryScale = category ? sanitizeScale(modulation.amplitude.perCategoryScale?.[category], 1) : 1;
    const modulatedIntensity = tag.intensity * intensityScale * categoryScale;

    // ─── Random jitter (HUD-tunable) ────────────────────────────────────
    // Jitter magnitudes can be damped by `timing.jitterScale` (e.g. a very
    // controlled persona wants smaller envelope randomisation).
    const { duration: dJBase, intensity: iJBase, intensityFloor } = this.compiler.getEffectiveJitter();
    const jitterScale = sanitizeScale(modulation.timing.jitterScale, 1);
    const dJ = dJBase * jitterScale;
    const iJ = iJBase * jitterScale;
    const duration = Math.max(1, Math.round(modulatedDuration * (1 + (Math.random() * 2 - 1) * dJ)));
    const intensity = Math.max(intensityFloor, Math.min(1, modulatedIntensity * (1 + (Math.random() * 2 - 1) * iJ)));

    // ─── Variant weights (persona action preference) ────────────────────
    const variantWeights = modulation.actionPref?.variantWeights?.[tag.action];

    const modulatedLog =
      modulation === IDENTITY_MODULATION
        ? ''
        : ` mod={iScale=${intensityScale.toFixed(2)},catScale=${categoryScale.toFixed(2)},speed=${speedScale.toFixed(2)},dBias=${durationBias}}`;
    logger.info(
      `[AvatarService] enqueueTagAnimation | action=${tag.action} emotion=${tag.emotion} intensity=${intensity.toFixed(2)} (base=${tag.intensity.toFixed(2)}) duration=${duration}ms (base=${baseDuration}ms) registered=${registered != null} override=${tag.durationOverrideMs ?? 'none'}${modulatedLog}`,
    );
    this.compiler.enqueue([
      {
        action: tag.action,
        emotion: tag.emotion,
        intensity,
        duration,
        easing: 'easeInOutCubic',
        timestamp: Date.now(),
        variantWeights,
      },
    ]);
  }

  /**
   * Persist an emotion pose on emotion-category channels
   * (mouth / eye.smile / brow / cheek). Reuses the action-map entry that
   * shares the emotion name (e.g. `happy`, `sad`, `thinking`), filters
   * down to facial channels, and seeds them directly into the compiler's
   * channelBaseline so the pose sticks until the next enqueueEmotion call
   * overwrites it. Unknown emotion → warn + no-op.
   */
  enqueueEmotion(name: string, intensity: number): void {
    if (!this.compiler) {
      logger.warn(`[AvatarService] enqueueEmotion dropped (no compiler) | emotion=${name}`);
      return;
    }
    const clamped = Math.max(0, Math.min(1, intensity));
    const resolved = this.compiler.resolveAction(name, name, clamped);
    if (!resolved) {
      logger.warn(`[AvatarService] enqueueEmotion unknown emotion | name=${name}`);
      return;
    }
    if (resolved.kind !== 'envelope') {
      logger.warn(`[AvatarService] enqueueEmotion non-envelope action | name=${name} kind=${resolved.kind}`);
      return;
    }
    const filtered = resolved.targets.filter((t) => isEmotionChannel(t.channel));
    if (filtered.length === 0) {
      logger.warn(`[AvatarService] enqueueEmotion produced no emotion channels | name=${name}`);
      return;
    }
    // Seed baseline directly — skips ADSR attack but the baseline decay
    // curve still produces a soft arrival. Values are already
    // intensity-scaled by resolveAction.
    const entries = filtered.map((t) => ({ channel: t.channel, value: t.targetValue }));
    this.compiler.seedChannelBaseline(entries);
    logger.info(
      `[AvatarService] enqueueEmotion | name=${name} intensity=${clamped.toFixed(2)} channels=${filtered.length}`,
    );
  }

  /**
   * Override the eye-gaze layer's target. `null` or `{type:'clear'}`
   * restores natural OU wandering.
   */
  setGazeTarget(target: GazeTarget | null): void {
    const layer = this.compiler?.getLayer('eye-gaze');
    // EyeGazeLayer has the method; cast via a narrow interface to avoid
    // importing the concrete class (prevents potential circular imports).
    const gazeCapable = layer as { setGazeTarget?: (t: GazeTarget | null) => void } | undefined;
    gazeCapable?.setGazeTarget?.(target);
  }

  /**
   * Low-level: walk to absolute scene coordinates. Kept on AvatarService for programmatic
   * / LLM use when the caller already has world coords. HUD and semantic callers should
   * prefer the `walkForward / strafe / turn / orbit` primitives below.
   */
  walkTo(x: number, z: number, face?: number): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.reject(new Error('[AvatarService] WalkingLayer is not available'));
    return layer.walkTo(x, z, face);
  }

  /** Translate `meters` along the character's current facing. Negative = backward. */
  walkForward(meters: number): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.reject(new Error('[AvatarService] WalkingLayer is not available'));
    return layer.walkForward(meters);
  }

  /** Strafe `meters` perpendicular to facing. Positive = character's right, negative = left. */
  strafe(meters: number): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.reject(new Error('[AvatarService] WalkingLayer is not available'));
    return layer.strafe(meters);
  }

  /** Turn in place by `radians`. Positive = character's right (CW from above). */
  turn(radians: number): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.reject(new Error('[AvatarService] WalkingLayer is not available'));
    return layer.turn(radians);
  }

  /** Orbit around a centre (defaults to `radius` metres left of character). */
  orbit(opts: Parameters<WalkingLayer['orbit']>[0]): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.reject(new Error('[AvatarService] WalkingLayer is not available'));
    return layer.orbit(opts);
  }

  /**
   * Semantic walk targets. Coordinates are convention-driven (stage front
   * sits on +Z near camera, `facing=0` looks toward +Z); no dependency on the
   * renderer's actual camera pose, so LLM-driven commands like `[W:to:camera]`
   * resolve deterministically without exchanging positions.
   */
  private static readonly STAGE_POSITIONS: Record<WalkToTarget, { x: number; z: number; face: number }> = {
    camera: { x: 0, z: 0.5, face: 0 },
    center: { x: 0, z: 0, face: 0 },
    back: { x: 0, z: -0.5, face: 0 },
  };
  private static readonly FACE_ANGLES: Record<FaceTarget, number> = {
    camera: 0,
    back: Math.PI,
    left: -Math.PI / 2,
    right: Math.PI / 2,
  };

  /** Walk to a named stage position. Resolves on cubism models as a no-op. */
  walkToSemantic(target: WalkToTarget): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.resolve();
    const pos = AvatarService.STAGE_POSITIONS[target];
    return layer.walkTo(pos.x, pos.z, pos.face);
  }

  /** Turn in place to a named facing direction (no translation). */
  faceSemantic(direction: FaceTarget): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.resolve();
    const face = AvatarService.FACE_ANGLES[direction];
    const cur = layer.getPosition();
    return layer.walkTo(cur.x, cur.z, face);
  }

  /** Interrupt any pending motion. Legacy alias is `stopWalk` (kept for now). */
  stopMotion(): void {
    this.getWalkingLayer()?.stop();
  }

  /** @deprecated — prefer `stopMotion`. */
  stopWalk(): void {
    this.stopMotion();
  }

  getCurrentPosition(): { x: number; z: number; facing: number } {
    return this.getWalkingLayer()?.getPosition() ?? { x: 0, z: 0, facing: 0 };
  }

  hasConsumer(): boolean {
    return this.consumerCount > 0;
  }

  /**
   * Returns a JSON-safe snapshot of all currently-connected renderers and their
   * latest capability reports. Each entry includes the ISO-string timestamp of
   * when the report was received and a best-effort remote address derived from
   * the Bun WebSocket object; falls back to `'unknown'` when no usable address
   * field is present (e.g. in tests using mock sockets).
   */
  listConnectedCapabilities(): Array<{
    remoteAddr: string;
    caps: RendererCapabilities;
    receivedAt: string;
  }> {
    const result: Array<{ remoteAddr: string; caps: RendererCapabilities; receivedAt: string }> = [];
    for (const [ws, entry] of this.connectedCapabilities) {
      // Bun's ServerWebSocket exposes `remoteAddress` at runtime; plain WebSocket
      // (browser / test) does not. Fall back to 'unknown' without throwing.
      const remoteAddr = (ws as unknown as { remoteAddress?: string }).remoteAddress ?? 'unknown';
      result.push({
        remoteAddr,
        caps: entry.caps,
        receivedAt: entry.receivedAt.toISOString(),
      });
    }
    return result;
  }

  speak(text: string): void {
    this.speechService?.speak(text, { maxCharsPerUtterance: this.config.speech.maxCharsPerUtterance });
  }

  isActive(): boolean {
    return this.started && this.config.enabled;
  }

  getConfig(): AvatarConfig {
    return this.config;
  }

  /**
   * Enumerate the currently loaded action-map entries. Used by:
   *  - PreviewServer `/action-map` HTTP route (HUD button list)
   *  - Prompt assembly (injects `{{availableActions}}` into avatar templates so
   *    the LLM's tag vocabulary stays in sync with the action-map JSON)
   * Returns `[]` if the compiler hasn't been initialized yet.
   */
  listActions(): ActionSummary[] {
    return this.compiler?.listActions() ?? [];
  }

  /** Proxy to AnimationCompiler.getActionDuration for callers outside the
   * compiler (e.g. TagAnimationStage pre-computing hold-adjusted duration). */
  getActionDuration(action: string): number | undefined {
    return this.compiler?.getActionDuration(action);
  }

  /** Resolves the `WalkingLayer` from the compiler’s {@link LayerManager} (registered in `initialize()`). */
  private getWalkingLayer(): WalkingLayer | undefined {
    const layer = this.compiler?.getLayer('walking');
    return layer instanceof WalkingLayer ? layer : undefined;
  }
}

/**
 * Format an action list as a Markdown-style bulleted list for injection into
 * avatar LLM prompts. Each line reads:
 *
 *   - `nod`: nods twice — agreement or affirmation
 *
 * Actions without a description fall back to just their name so the LLM at
 * least knows the action exists. The output is stable/sorted by category order
 * (emotion → movement → micro → other) then by appearance in the action-map
 * so prompt-cache hits survive action-map reorderings within a bucket.
 */
export function formatActionsForPrompt(actions: ActionSummary[]): string {
  const CATEGORY_ORDER: readonly string[] = ['emotion', 'movement', 'micro'];
  const byCategory = new Map<string, ActionSummary[]>();
  for (const a of actions) {
    const key = a.category && CATEGORY_ORDER.includes(a.category) ? a.category : '_other';
    const bucket = byCategory.get(key) ?? [];
    bucket.push(a);
    byCategory.set(key, bucket);
  }
  const lines: string[] = [];
  const emit = (bucket: ActionSummary[] | undefined): void => {
    if (!bucket) return;
    for (const a of bucket) {
      lines.push(a.description ? `- \`${a.name}\`: ${a.description}` : `- \`${a.name}\``);
    }
  };
  for (const cat of CATEGORY_ORDER) emit(byCategory.get(cat));
  emit(byCategory.get('_other'));
  return lines.join('\n');
}

function toStateNodes(nodes: StateNodeOutput[]): StateNode[] {
  const now = Date.now();
  return nodes.map((n) => ({
    action: n.action,
    emotion: n.emotion,
    intensity: n.intensity,
    duration: n.duration,
    delay: n.delay,
    easing: n.easing as StateNode['easing'],
    timestamp: n.timestamp ?? now,
  }));
}

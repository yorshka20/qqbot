import { singleton } from 'tsyringe';
import { AnimationCompiler } from './compiler/AnimationCompiler';
import { isEmotionChannel } from './compiler/emotion-channels';
import type { AmbientAudioLayer } from './compiler/layers/AmbientAudioLayer';
import type { IdleClip } from './compiler/layers/clips/types';
import { IdleMotionLayer } from './compiler/layers/IdleMotionLayer';
import type { PersonaPostureBias } from './compiler/layers/PersonaPostureLayer';
import { WalkingLayer } from './compiler/layers/WalkingLayer';
import type { ActionSummary, StateNode, StateNodeSource } from './compiler/types';
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
import type { PreviewStatus, RendererCapabilities, WalkCommandData } from './preview/types';
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
  /**
   * Optional callback that returns the current mind-state snapshot for
   * HUD broadcast. Kept as a plain callback so the avatar package does
   * not depend on the mind module's types; see `PreviewStatus.mindState`
   * for the loose shape consumers should return.
   */
  private mindStateSource?: () => PreviewStatus['mindState'] | undefined;

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
      if (!idleLayer) {
        logger.info(
          `[AvatarService] IdleMotionLayer not registered (compiler.debugQuiet=true?); idle clip "${idleActionName}" skipped`,
        );
      } else if (idleLayer instanceof IdleMotionLayer) {
        const clips = this.compiler.getClipsByActionName(idleActionName);
        if (clips && clips.length > 0) {
          idleLayer.setLoopClips(clips);
          const totalSec = clips.reduce((s, c) => s + c.duration, 0);
          logger.info(
            `[AvatarService] IdleMotionLayer loop mode enabled with action "${idleActionName}" (${clips.length} variant${clips.length === 1 ? '' : 's'}, ~${totalSec.toFixed(1)}s pooled)`,
          );
        } else {
          logger.warn(
            `[AvatarService] idle.loopClipActionName="${idleActionName}" did not resolve to any clip; idle layer stays in gap mode`,
          );
        }
      }
    }

    const walkingLayer = this.compiler.getLayer('walking');
    const walkByDir = this.config.compiler.walk?.cycleClipActionNameByDirection;
    const walkCycleName = this.config.compiler.walk?.cycleClipActionName;
    if (walkByDir && walkingLayer instanceof WalkingLayer) {
      // Directional binding takes precedence — resolve all 4 cardinal clips
      // and hand the table to the layer. Missing entries are passed through
      // as `undefined`; the layer will reject motions in those directions.
      const resolved: { forward?: IdleClip; backward?: IdleClip; left?: IdleClip; right?: IdleClip } = {};
      const log: string[] = [];
      for (const dir of ['forward', 'backward', 'left', 'right'] as const) {
        const name = walkByDir[dir];
        if (!name) {
          log.push(`${dir}=∅`);
          continue;
        }
        const clip = this.compiler.getClipByActionName(name);
        if (clip) {
          resolved[dir] = clip;
          log.push(`${dir}=${name}(${clip.duration.toFixed(2)}s)`);
        } else {
          log.push(`${dir}=${name}(missing)`);
        }
      }
      walkingLayer.setWalkCycleClipsByDirection(resolved);
      logger.info(`[AvatarService] WalkingLayer directional cycle clips: ${log.join(', ')}`);
    } else if (walkCycleName && walkingLayer instanceof WalkingLayer) {
      const walkClip = this.compiler.getClipByActionName(walkCycleName);
      if (walkClip) {
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
        // Mind snapshot is optional — undefined when no source registered.
        mindState: this.mindStateSource?.(),
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

  /**
   * Register (or clear) the mind-state snapshot source. Called at
   * bootstrap by the bot-side wiring. The callback is invoked on every
   * `startStatusBroadcast` tick; its return value is forwarded verbatim
   * on `PreviewStatus.mindState` for HUD display. Return `undefined` to
   * hide the mind panel.
   */
  setMindStateSource(source: (() => PreviewStatus['mindState'] | undefined) | undefined): void {
    this.mindStateSource = source;
    logger.info(`[AvatarService] MindStateSource ${source ? 'registered' : 'cleared'}`);
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
    this._enqueueModulated(tag.action, tag.emotion, tag.intensity, baseDuration, 'llm', {
      durationOverrideMs: tag.durationOverrideMs,
      registered,
    });
  }

  /**
   * Queue a programmatic action animation onto the compiler, bypassing LLM
   * tag parsing. The call still travels through the full modulation + jitter
   * pipeline so persona-driven scaling applies exactly as it does for
   * `enqueueTagAnimation`. The resulting `StateNode` carries `source:
   * 'autonomous'` so HUD traces and logs can distinguish the two paths.
   *
   * @param actionName - Key in the action-map (e.g. 'emotion_smile', 'micro_blink').
   * @param intensity  - Base intensity in [0, 1] (clamped before modulation).
   * @param opts       - Optional overrides; `durationOverrideMs` replaces the
   *                     action-map default as the jitter base.
   */
  enqueueAutonomous(
    actionName: string,
    intensity: number,
    opts?: { emotion?: string; durationOverrideMs?: number },
  ): void {
    if (!this.compiler) {
      logger.warn(`[AvatarService] enqueueAutonomous dropped (no compiler) | action=${actionName}`);
      return;
    }
    const registered = this.compiler.getActionDuration(actionName);
    const baseDuration = opts?.durationOverrideMs ?? registered ?? 1500;
    const emotion = opts?.emotion ?? 'neutral';
    this._enqueueModulated(actionName, emotion, intensity, baseDuration, 'autonomous', {
      durationOverrideMs: opts?.durationOverrideMs,
      registered,
    });
  }

  /**
   * Shared modulation + jitter pipeline called by both `enqueueTagAnimation`
   * (source='llm') and `enqueueAutonomous` (source='autonomous'). Keeps the
   * two public APIs in sync: any change to modulation math here applies to
   * both paths automatically.
   *
   * @param actionName    - Action key in the action-map.
   * @param emotion       - Emotion label forwarded to the StateNode.
   * @param baseIntensity - Pre-modulation intensity (clamped by caller or here).
   * @param baseDuration  - Pre-modulation duration in ms.
   * @param source        - Pipeline origin marker written onto the StateNode.
   * @param meta          - Extra fields only used for the log line.
   */
  private _enqueueModulated(
    actionName: string,
    emotion: string,
    baseIntensity: number,
    baseDuration: number,
    source: StateNodeSource,
    meta: { durationOverrideMs?: number; registered: number | undefined },
  ): void {
    // Compiler null-guard is at the call site (enqueueTagAnimation /
    // enqueueAutonomous) — we assert non-null here for a clean cast.
    const compiler = this.compiler!;

    // ─── Persona modulation (deterministic) ─────────────────────────────
    const category = compiler.getActionCategory(actionName) as ActionCategory | undefined;
    const modulation =
      this.modulationProvider?.getModulation({
        actionName,
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
    const modulatedIntensity = baseIntensity * intensityScale * categoryScale;

    // ─── Random jitter (HUD-tunable) ────────────────────────────────────
    // Jitter magnitudes can be damped by `timing.jitterScale` (e.g. a very
    // controlled persona wants smaller envelope randomisation).
    const { duration: dJBase, intensity: iJBase, intensityFloor } = compiler.getEffectiveJitter();
    const jitterScale = sanitizeScale(modulation.timing.jitterScale, 1);
    const dJ = dJBase * jitterScale;
    const iJ = iJBase * jitterScale;
    const duration = Math.max(1, Math.round(modulatedDuration * (1 + (Math.random() * 2 - 1) * dJ)));
    const intensity = Math.max(intensityFloor, Math.min(1, modulatedIntensity * (1 + (Math.random() * 2 - 1) * iJ)));

    // ─── Variant weights (persona action preference) ────────────────────
    const variantWeights = modulation.actionPref?.variantWeights?.[actionName];

    const modulatedLog =
      modulation === IDENTITY_MODULATION
        ? ''
        : ` mod={iScale=${intensityScale.toFixed(2)},catScale=${categoryScale.toFixed(2)},speed=${speedScale.toFixed(2)},dBias=${durationBias}}`;
    logger.info(
      `[AvatarService] enqueueModulated | source=${source} action=${actionName} emotion=${emotion} intensity=${intensity.toFixed(2)} (base=${baseIntensity.toFixed(2)}) duration=${duration}ms (base=${baseDuration}ms) registered=${meta.registered != null} override=${meta.durationOverrideMs ?? 'none'}${modulatedLog}`,
    );
    compiler.enqueue([
      {
        action: actionName,
        emotion,
        intensity,
        duration,
        easing: 'easeInOutCubic',
        timestamp: Date.now(),
        variantWeights,
        source,
      },
    ]);

    // Face composition: a clip-kind action may declare a paired face envelope
    // (`face: 'emotion_smile'`) so emotion clips animate body and face
    // together. Footprints don't overlap (skeleton vs blendshape channels) so
    // the arbiter coexists them. Face piggybacks on the body's already-
    // modulated intensity & duration to stay in sync. Single-level fan-out:
    // the face action is an envelope, which has no `face` field.
    const face = compiler.getActionFace(actionName);
    if (face) {
      compiler.enqueue([
        {
          action: face,
          emotion,
          intensity,
          duration,
          easing: 'easeInOutCubic',
          timestamp: Date.now(),
          source,
        },
      ]);
    }
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
    this._applyEmotionBaseline(name, intensity, 'llm');
  }

  /**
   * Programmatic variant of `enqueueEmotion` — same semantics (baseline seed
   * on emotion-category channels), but the call is not produced by an LLM
   * reply. The `source` label in the log line reflects the autonomous origin
   * so debug traces distinguish both paths.
   *
   * @param name      - Emotion / action name to look up in the action-map.
   * @param intensity - Desired intensity in [0, 1] (clamped internally).
   */
  enqueueAutonomousEmotion(name: string, intensity: number): void {
    if (!this.compiler) {
      logger.warn(`[AvatarService] enqueueAutonomousEmotion dropped (no compiler) | emotion=${name}`);
      return;
    }
    this._applyEmotionBaseline(name, intensity, 'autonomous');
  }

  /**
   * Shared core for `enqueueEmotion` and `enqueueAutonomousEmotion`. Resolves
   * the action-map entry, filters to facial/emotion channels, and seeds the
   * compiler baseline. The `source` label is used only for log output — it
   * does not affect the baseline values written to the compiler.
   */
  private _applyEmotionBaseline(name: string, intensity: number, source: StateNodeSource): void {
    // Compiler non-null guaranteed by both public call sites.
    const compiler = this.compiler!;
    const clamped = Math.max(0, Math.min(1, intensity));
    const resolved = compiler.resolveAction(name, name, clamped);
    if (!resolved) {
      logger.warn(`[AvatarService] enqueueEmotion unknown emotion | source=${source} name=${name}`);
      return;
    }
    if (resolved.kind !== 'envelope') {
      logger.warn(
        `[AvatarService] enqueueEmotion non-envelope action | source=${source} name=${name} kind=${resolved.kind}`,
      );
      return;
    }
    const filtered = resolved.targets.filter((t) => isEmotionChannel(t.channel));
    if (filtered.length === 0) {
      logger.warn(`[AvatarService] enqueueEmotion produced no emotion channels | source=${source} name=${name}`);
      return;
    }
    // Seed baseline directly — skips ADSR attack but the baseline decay
    // curve still produces a soft arrival. Values are already
    // intensity-scaled by resolveAction.
    const entries = filtered.map((t) => ({ channel: t.channel, value: t.targetValue }));
    compiler.seedChannelBaseline(entries);
    logger.info(
      `[AvatarService] enqueueEmotion | source=${source} name=${name} intensity=${clamped.toFixed(2)} channels=${filtered.length}`,
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
   * Apply a partial posture-bias to the persona-posture layer.
   * All fields are optional; passing `{}` is a valid no-op.
   * Safe to call before the compiler is initialized.
   */
  setPersonaPostureBias(bias: PersonaPostureBias): void {
    const layer = this.compiler?.getLayer('persona-posture');
    const postureCapable = layer as { setBias?: (bias: PersonaPostureBias) => void } | undefined;
    postureCapable?.setBias?.(bias);
  }

  /**
   * Sustained head-look override — the avatar points its head at the given yaw / pitch
   * (in degrees, clamped to the head-channel ±30° range). Pass `null` to release the
   * override; the layer drifts back to neutral and then stops emitting so discrete head
   * actions (nod / shake_head) own the channel cleanly.
   *
   * Semantically distinct from {@link setGazeTarget}:
   *   - `setGazeTarget`  — eyes only (plus a mild OU-drift smoothing of `eye.ball.x/y`)
   *   - `setHeadLook`    — head rotation only (body stays still)
   *   - `walkForward / turn` — body / root rotation
   *
   * Callers that want "look there with head + eyes" combine both calls; the two layers
   * coordinate independently. `head.yaw` / `head.pitch` contributions from this layer
   * stack additively with discrete nod / shake_head envelope actions — shaking head
   * while looking left reads as "no" centred on the look offset, which is the
   * desired semantic.
   */
  setHeadLook(target: { yaw?: number; pitch?: number } | null): void {
    const layer = this.compiler?.getLayer('head-look');
    const capable = layer as { setHeadLook?: (t: { yaw?: number; pitch?: number } | null) => void } | undefined;
    capable?.setHeadLook?.(target);
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

  /**
   * Vector-merge consecutive relative motion into one walkTo call. Uses the current
   * position snapshot so forward/strafe/turn deltas compose correctly.
   *
   * - forwardM:  metres along the character's current facing (positive = forward)
   * - strafeM:   metres perpendicular to facing (positive = character's right)
   * - turnRad:   additional facing delta (positive = CW from above)
   */
  walkRelative(forwardM: number, strafeM: number, turnRad: number): Promise<void> {
    const layer = this.getWalkingLayer();
    if (!layer) return Promise.reject(new Error('[AvatarService] WalkingLayer is not available'));
    const { x, z, facing } = layer.getPosition();
    const targetX = x + forwardM * Math.sin(facing) + strafeM * Math.cos(facing);
    const targetZ = z + forwardM * Math.cos(facing) + strafeM * (-Math.sin(facing));
    const targetFacing = facing + turnRad;
    return layer.walkTo(targetX, targetZ, targetFacing);
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

  /**
   * Current `AvatarActivity` from the state machine, or `null` if the
   * avatar system has not been initialized. Exposed so external
   * subsystems (notably `MindService`) can read pose / ambientGain
   * without owning a reference to the state machine.
   */
  getCurrentActivity(): { pose: string; ambientGain: number } | null {
    return this.stateMachine?.current ?? null;
  }

  /**
   * Tier A / B channel occupancy — which channels active discrete animations
   * currently hold. Consumers (wander scheduler, autonomous enqueue callers)
   * query this to avoid starting new motion while an action is in flight.
   * Empty set when the compiler is not initialised. Thin delegate over
   * `AnimationCompiler.getOccupiedChannels` — see that method for the tier
   * model and exclusions.
   */
  getOccupiedChannels(): Set<string> {
    return this.compiler?.getOccupiedChannels() ?? new Set<string>();
  }

  /**
   * Intersection of `footprint` with current channel occupancy. Empty set
   * means every channel is free and the caller may proceed; a non-empty
   * set names the specific conflicts. Returns `footprint` as an empty
   * conflict set when the compiler is not initialised (nothing can conflict
   * with a non-running pipeline).
   */
  checkAvailable(footprint: Iterable<string>): Set<string> {
    // Wander/IdleScheduler callsite: must see continuous-layer ownership so
    // root-translation steps are blocked while idle-layer holds leg/spine
    // channels. Discrete enqueue paths (`processQueue` cross-action check)
    // call `compiler.checkAvailable` directly with the default
    // `includeContinuousLayers=false` — see AnimationCompiler.ts.
    return this.compiler?.checkAvailable(footprint, { includeContinuousLayers: true }) ?? new Set<string>();
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
  // Order optimized for LLM prompt scan: expressive intent first (emotion /
  // reaction / greet), then situational (pose / idle / locomotion / combat),
  // then auto-fidget micros, then UI-only costume. `movement` is kept for
  // back-compat with any envelope entries still using the old single-bucket
  // category. Anything outside this list falls through to `_other`.
  const CATEGORY_ORDER: readonly string[] = [
    'emotion',
    'reaction',
    'greet',
    'pose',
    'idle',
    'locomotion',
    'combat',
    'movement',
    'micro',
    'costume',
  ];
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

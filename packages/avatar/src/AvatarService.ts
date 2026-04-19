import { singleton } from 'tsyringe';
import { AnimationCompiler } from './compiler/AnimationCompiler';
import { createDefaultLayers } from './compiler/layers';
import type { StateNode } from './compiler/types';
import { mergeAvatarConfig } from './config';
import { VTSDriver } from './drivers/VTSDriver';
import { PreviewServer } from './preview/PreviewServer';
import { IdleStateMachine } from './state/IdleStateMachine';
import type { BotState, StateNodeOutput } from './state/types';
import type { AvatarConfig } from './types';
import { DEFAULT_AVATAR_CONFIG } from './types';
import { logger } from './utils/logger';

@singleton()
export class AvatarService {
  private config: AvatarConfig = DEFAULT_AVATAR_CONFIG;
  private compiler: AnimationCompiler | null = null;
  private stateMachine: IdleStateMachine | null = null;
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

  /**
   * Merge + apply the raw (JSONC-parsed) avatar config and initialize all
   * subsystems. Must be called before `start()`. No network I/O occurs here.
   *
   * Accepts the raw blob from `ConfigManager.getAvatarConfig()` so hosts
   * don't have to know the schema — the merge happens in `mergeAvatarConfig`
   * next door. `undefined` is treated as "no avatar section" and leaves the
   * service disabled.
   */
  async initialize(rawConfig: Record<string, unknown> | undefined): Promise<void> {
    const config = mergeAvatarConfig(rawConfig);
    this.config = config;

    if (!config.enabled) {
      logger.debug('[AvatarService] Disabled, skipping initialization');
      return;
    }

    this.compiler = new AnimationCompiler(config.compiler, config.actionMap?.path);
    this.stateMachine = new IdleStateMachine();

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

    if (config.preview.enabled) {
      this.previewServer = new PreviewServer(
        {
          host: config.preview.host,
          port: config.preview.port,
        },
        {
          onTrigger: (data) =>
            this.enqueueTagAnimation({
              action: data.action,
              emotion: data.emotion ?? 'neutral',
              intensity: data.intensity ?? 1.0,
            }),
          onClientCountChange: (count) => this.handlePreviewClientCount(count),
        },
      );
    }

    logger.debug('[AvatarService] Initialized', { enabled: config.enabled });
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

    // Register the continuous layer stack before the compiler starts ticking
    // so the first tick already has breath/blink/gaze available.
    if (this.config.compiler.layers?.enabled !== false) {
      const layers = createDefaultLayers();
      for (const layer of layers) {
        this.compiler.registerLayer(layer);
      }
      logger.info(
        '[AvatarService] Animation layers registered:',
        layers.map((l) => l.id),
      );
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

    // Enter idle state for gate policy. If no consumer has arrived yet the
    // compiler stays paused; the transition nodes sit in the queue and will
    // play cleanly once the tick resumes.
    this.transition('idle');

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
      this.previewServer.updateStatus({
        state: this.stateMachine.currentState,
        fps: this.measuredFps,
        activeAnimations: this.compiler.getActiveAnimationCount(),
        queueLength: this.compiler.getQueueLength(),
      });
    }, 1000);
  }

  /**
   * Transition the avatar to a new bot state.
   * Emits the matching transition animations to the compiler queue.
   */
  transition(state: BotState): void {
    if (!this.stateMachine || !this.compiler) return;
    this.compiler.setGateState(state);
    const nodes = this.stateMachine.transition(state);
    if (nodes.length > 0) {
      this.compiler.enqueue(toStateNodes(nodes));
    }
  }

  /**
   * Queue a single LLM-authored action animation onto the compiler.
   * Duration defaults to the action-map's registered value, or 1500ms if
   * the action is unknown (the compiler will silently drop it in that case).
   */
  enqueueTagAnimation(tag: { emotion: string; action: string; intensity: number }): void {
    if (!this.compiler) return;
    const duration = this.compiler.getActionDuration(tag.action) ?? 1500;
    this.compiler.enqueue([
      {
        action: tag.action,
        emotion: tag.emotion,
        intensity: tag.intensity,
        duration,
        easing: 'easeInOutCubic',
        timestamp: Date.now(),
      },
    ]);
  }

  isActive(): boolean {
    return this.started && this.config.enabled;
  }

  getConfig(): AvatarConfig {
    return this.config;
  }
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

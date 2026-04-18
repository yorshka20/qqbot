import { singleton } from 'tsyringe';
import { logger } from './utils/logger';
import { AnimationCompiler } from './compiler/AnimationCompiler';
import type { StateNode } from './compiler/types';
import { VTSDriver } from './drivers/VTSDriver';
import { PreviewServer } from './preview/PreviewServer';
import { IdleStateMachine } from './state/IdleStateMachine';
import type { BotState, StateNodeOutput } from './state/types';
import type { AvatarConfig } from './types';
import { DEFAULT_AVATAR_CONFIG } from './types';

@singleton()
export class AvatarService {
  private config: AvatarConfig = DEFAULT_AVATAR_CONFIG;
  private compiler: AnimationCompiler | null = null;
  private stateMachine: IdleStateMachine | null = null;
  private driver: VTSDriver | null = null;
  private previewServer: PreviewServer | null = null;
  private started = false;

  /**
   * Initialize all avatar subsystems with the given config.
   * Must be called before start(). No network I/O occurs here.
   */
  async initialize(config: AvatarConfig): Promise<void> {
    this.config = config;

    if (!config.enabled) {
      logger.debug('[AvatarService] Disabled, skipping initialization');
      return;
    }

    this.compiler = new AnimationCompiler(config.compiler);
    this.stateMachine = new IdleStateMachine(config.idle);
    this.driver = new VTSDriver(config.vts);

    if (config.preview.enabled) {
      this.previewServer = new PreviewServer({
        host: config.preview.host,
        port: config.preview.port,
      });
    }

    logger.debug('[AvatarService] Initialized', { enabled: config.enabled });
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
    if (!this.compiler || !this.stateMachine || !this.driver) {
      logger.warn('[AvatarService] start() called before initialize() — skipping');
      return;
    }

    // Wire idle animations from state machine → compiler queue
    this.stateMachine.on('idle-animation', (nodes: StateNodeOutput[]) => {
      this.compiler?.enqueue(toStateNodes(nodes));
    });

    // Wire compiled frames → driver (fire-and-forget) + preview broadcast
    this.compiler.on('frame', (frame) => {
      this.driver?.sendFrame(frame.params).catch(() => {});
      this.previewServer?.broadcastFrame({ timestamp: frame.timestamp, params: frame.params });
    });

    // Start the animation engine and idle timer
    this.compiler.start();
    this.stateMachine.start();

    if (this.previewServer) {
      await this.previewServer.start();
      logger.info(`[AvatarService] Preview server started on ${this.config.preview.host}:${this.config.preview.port}`);
    }

    // Connect to VTubeStudio (non-fatal: bot works without avatar driver)
    try {
      await this.driver.connect();
    } catch (err) {
      logger.warn('[AvatarService] Driver failed to connect (non-fatal):', err);
    }

    // Enter idle state to kick off the idle animation timer
    this.transition('idle');

    this.started = true;
    logger.info('[AvatarService] Started');
  }

  /**
   * Stop the avatar system and release all resources.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

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
   * Transition the avatar to a new bot state.
   * Emits the matching transition animations to the compiler queue.
   */
  transition(state: BotState): void {
    if (!this.stateMachine || !this.compiler) return;
    const nodes = this.stateMachine.transition(state);
    if (nodes.length > 0) {
      this.compiler.enqueue(toStateNodes(nodes));
    }
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

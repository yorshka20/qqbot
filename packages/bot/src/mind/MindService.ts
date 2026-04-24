/**
 * MindService — orchestrator for the mind subsystem.
 *
 * Phase 1 responsibilities:
 *   1. Own the Phenotype singleton (in-memory, per-process).
 *   2. Tick the ODE on a fixed timer, reading the avatar's pose to
 *      decide whether the bot is "active" (so fatigue accrues).
 *   3. Subscribe to `message_received` events on the InternalEventBus
 *      and translate them into attention-spike stimuli.
 *   4. Produce HUD snapshots on demand.
 *
 * The service does NOT import avatar internals — it holds a thin
 * `PoseProvider` callback set at wiring time. This keeps mind → avatar
 * a one-way soft dep (avatar also doesn't import mind).
 */

import type { InternalEventBus } from '@/agenda/InternalEventBus';
import type { AgendaSystemEvent } from '@/agenda/types';
import { logger } from '@/utils/logger';
import { applyStimulus, deriveModulation, freshPhenotype, tickPhenotype } from './ode';
import type { MindConfig, MindStateSnapshot, Phenotype, Stimulus } from './types';

/**
 * The event type `MessagePipeline` publishes after a successful
 * `lifecycle.execute`. Kept as a constant here so producer + subscriber
 * stay in lockstep without a cross-package import.
 */
export const MIND_EVENT_MESSAGE_RECEIVED = 'mind.message_received' as const;

/**
 * Minimal view onto the avatar: "is the bot doing something right now?"
 * Phase 1 only needs a boolean to gate fatigue accrual. A future
 * PoseProvider may expand to return richer activity (speaking vs
 * thinking) so we can differentiate accrual rates.
 */
export type PoseProvider = () => { isActive: boolean };

export class MindService {
  private phenotype: Phenotype = freshPhenotype();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = Date.now();
  private started = false;
  private poseProvider: PoseProvider | null = null;
  private readonly messageHandler = (event: AgendaSystemEvent): void => {
    this.handleMessageEvent(event);
  };

  constructor(
    private readonly config: MindConfig,
    private readonly eventBus: InternalEventBus,
  ) {}

  /**
   * Wire the pose provider. Called from bootstrap after both mind and
   * avatar are instantiated. Safe to call before or after `start()`.
   */
  setPoseProvider(provider: PoseProvider | null): void {
    this.poseProvider = provider;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): MindConfig {
    return this.config;
  }

  /** Start tick loop + event subscription. Idempotent. */
  start(): void {
    if (this.started) return;
    if (!this.config.enabled) {
      logger.info('[MindService] Disabled by config — not starting tick loop');
      return;
    }
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.tick(), this.config.tickMs);
    this.eventBus.subscribe(MIND_EVENT_MESSAGE_RECEIVED, this.messageHandler);
    this.started = true;
    logger.info(
      `[MindService] Started | persona=${this.config.personaId} tickMs=${this.config.tickMs} fatigueAccrual=${this.config.ode.fatigueAccrualPerMs} tauAttention=${this.config.ode.tauAttentionMs}ms`,
    );
  }

  /** Stop tick loop + unsubscribe. Idempotent. */
  stop(): void {
    if (!this.started) return;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.eventBus.unsubscribe(MIND_EVENT_MESSAGE_RECEIVED, this.messageHandler);
    this.started = false;
    logger.info('[MindService] Stopped');
  }

  /**
   * Inject a stimulus directly. Used by the event handler and by tests
   * (so tests don't need to spin up the real event bus).
   */
  ingest(stimulus: Stimulus): void {
    if (!this.config.enabled) return;
    this.phenotype = applyStimulus(this.phenotype, stimulus, this.config);
  }

  /** Read-only phenotype. */
  getPhenotype(): Phenotype {
    return this.phenotype;
  }

  /**
   * Build a HUD-friendly snapshot. Includes the derived modulation so
   * the HUD can show both cause (fatigue) and effect (intensityScale)
   * in the same panel.
   */
  getSnapshot(): MindStateSnapshot {
    const modulation = deriveModulation(this.phenotype, this.config);
    return {
      enabled: this.config.enabled,
      personaId: this.config.personaId,
      phenotype: { ...this.phenotype },
      modulation,
      capturedAt: Date.now(),
    };
  }

  /**
   * Project the phenotype onto avatar modulation scalars. Stateless
   * read; safe to call from anywhere (including the modulation
   * provider's hot path on every `enqueueTagAnimation`).
   */
  deriveModulation(): ReturnType<typeof deriveModulation> {
    return deriveModulation(this.phenotype, this.config);
  }

  private tick(): void {
    const now = Date.now();
    const dtMs = now - this.lastTickAt;
    this.lastTickAt = now;
    const isActive = this.poseProvider?.().isActive ?? false;
    this.phenotype = tickPhenotype(this.phenotype, dtMs, isActive, this.config);
  }

  private handleMessageEvent(event: AgendaSystemEvent): void {
    if (!this.config.enabled) return;
    this.ingest({
      kind: 'message',
      ts: Date.now(),
      userId: event.userId || undefined,
      groupId: event.groupId || undefined,
    });
  }
}

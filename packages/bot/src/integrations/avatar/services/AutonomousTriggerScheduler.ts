/**
 * AutonomousTriggerScheduler — translates mind phenotype state into
 * discrete autonomous avatar triggers.
 *
 * Runs on a 1Hz timer independent of the mind tick so the mind tick
 * stays a pure ODE computation and this layer owns "translate state →
 * visible behavior" exclusively.
 *
 * Two trigger families:
 *   - Fatigue yawn: when fatigue exceeds threshold, fire one
 *     enqueueAutonomous(refresh) per randomised 5–10 min cooldown.
 *   - Valence drift: state-machine over (sad / neutral / happy) bands.
 *     Enqueue an emotion baseline (via enqueueAutonomousEmotion) only
 *     when crossing INTO a band. Hysteresis: between the entry
 *     threshold and the neutral window the band stays put, preventing
 *     flapping when valence wobbles around -0.3 / 0.5.
 *
 * Phenotype.valence is optional (Phase 1 phenotype lacks the field);
 * read defensively with `?? 0` to match existing ode.ts convention.
 * Do NOT add valence to the Phenotype type from here.
 */

import type { AvatarService } from '@qqbot/avatar';
import { logger } from '@/utils/logger';
import type { PersonaService } from '@/persona/PersonaService';
import type { PersonaConfig } from '@/persona/types';

type DriftBand = 'sad' | 'neutral' | 'happy' | null;

export interface AutonomousTriggerSchedulerDeps {
  /** Phenotype source. Only `getPhenotype()` is used. */
  mind: Pick<PersonaService, 'getPhenotype'>;
  /** Avatar enqueue surface. Only the two autonomous APIs are used.
   *  `hasConsumer` is queried each tick so we skip when no renderer/VTS is
   *  connected — same rationale as `WanderScheduler`'s consumer gate. */
  avatar: Pick<AvatarService, 'enqueueAutonomous' | 'enqueueAutonomousEmotion' | 'hasConsumer'>;
  /** Source of "now" in ms. Defaults to `Date.now`. Tests inject a fake clock. */
  now?: () => number;
  /** Source of `[0,1)` randomness. Defaults to `Math.random`. */
  random?: () => number;
}

export class AutonomousTriggerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastYawnAt: number | null = null;
  /** Sampled after each fire; initial value unused since first fire is unconditional. */
  private nextYawnCooldownMs = 0;
  private currentDriftBand: DriftBand = null;

  private readonly mind: AutonomousTriggerSchedulerDeps['mind'];
  private readonly avatar: AutonomousTriggerSchedulerDeps['avatar'];
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly config: PersonaConfig['autonomousTrigger'],
    deps: AutonomousTriggerSchedulerDeps,
  ) {
    this.mind = deps.mind;
    this.avatar = deps.avatar;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
  }

  start(intervalMs = 1000): void {
    if (this.started) return;
    if (!this.config.enabled) {
      logger.info('[AutonomousTriggerScheduler] Disabled by config — not starting');
      return;
    }
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.started = true;
    logger.info(
      `[AutonomousTriggerScheduler] Started | yawnThreshold=${this.config.yawn.fatigueThreshold} valence(neg/pos)=${this.config.valenceDrift.negativeThreshold}/${this.config.valenceDrift.positiveThreshold}`,
    );
  }

  stop(): void {
    if (!this.started) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** Single evaluation step. Public so tests drive it without a real timer. */
  tick(): void {
    if (!this.config.enabled) return;
    // Mirror WanderScheduler: skip the tick body when no renderer / VTS is
    // connected. The avatar pipeline is paused, so any enqueued autonomous
    // animation would be wasted (dropped by dedup, logs spammed).
    if (!this.avatar.hasConsumer()) return;
    const now = this.now();
    const phenotype = this.mind.getPhenotype();
    this.checkFatigueYawn(phenotype, now);
    this.checkValenceDrift(phenotype as { valence?: number });
  }

  private checkFatigueYawn(phenotype: { fatigue: number }, now: number): void {
    const { yawn } = this.config;
    if (phenotype.fatigue <= yawn.fatigueThreshold) return;
    if (this.lastYawnAt !== null && now - this.lastYawnAt < this.nextYawnCooldownMs) return;
    this.avatar.enqueueAutonomous(yawn.actionName, yawn.intensity);
    this.lastYawnAt = now;
    this.nextYawnCooldownMs = this.sampleYawnCooldown();
  }

  private checkValenceDrift(phenotype: { valence?: number }): void {
    const v = this.config.valenceDrift;
    const valence = phenotype.valence ?? 0;
    const band = this.classifyBand(valence);
    if (band === this.currentDriftBand) return;

    if (band === 'sad') {
      const intensity = clamp(Math.abs(valence) * v.sadIntensityFactor, v.sadIntensityMin, v.sadIntensityMax);
      this.avatar.enqueueAutonomousEmotion(v.sadEmotionName, intensity);
    } else if (band === 'happy') {
      const intensity = clamp(valence * v.happyIntensityFactor, v.happyIntensityMin, v.happyIntensityMax);
      this.avatar.enqueueAutonomousEmotion(v.happyEmotionName, intensity);
    } else if (band === 'neutral' && this.currentDriftBand !== null) {
      this.avatar.enqueueAutonomousEmotion(v.neutralEmotionName, 0);
    }
    this.currentDriftBand = band;
  }

  /**
   * Hysteresis-aware band classification. Returns null for the initial
   * neutral state so the very first tick at valence=0 does NOT enqueue
   * a neutral release (we only release when leaving a non-null drift).
   *
   * Inside the dead-band [negativeThreshold, neutralLowMin) and
   * (neutralHighMax, positiveThreshold]: keep the current band so
   * valence wobbles don't cause flapping.
   */
  private classifyBand(valence: number): DriftBand {
    const v = this.config.valenceDrift;
    if (valence < v.negativeThreshold) return 'sad';
    if (valence > v.positiveThreshold) return 'happy';
    if (valence >= v.neutralLowMin && valence <= v.neutralHighMax) return 'neutral';
    return this.currentDriftBand; // dead-band → hold
  }

  private sampleYawnCooldown(): number {
    const { cooldownMinMs, cooldownMaxMs } = this.config.yawn;
    const lo = Math.min(cooldownMinMs, cooldownMaxMs);
    const hi = Math.max(cooldownMinMs, cooldownMaxMs);
    return lo + this.random() * (hi - lo);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

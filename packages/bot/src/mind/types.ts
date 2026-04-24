/**
 * Mind system types — Phase 1.
 *
 * Keep this module narrowly scoped to what Phase 1 actually consumes:
 * Phenotype (fatigue / attention), stimulus events, modulation output,
 * HUD-facing snapshot. Epigenetics, reflection, and Strategy types will
 * live in `epigenetics.ts` / `strategy.ts` when those phases land —
 * defining their shape now would either be vapor or force us to import
 * types we don't need yet.
 *
 * Design reference: `docs/local/mind-system-design.md`.
 */

/**
 * Persona identifier. Phase 1 only has a single hardcoded `default`
 * persona; Phase 4 introduces persona presets loaded from JSON. Kept as
 * a string so callers can already thread it through without refactor.
 */
export type PersonaId = string;

/**
 * Runtime-evolving mind state (Kahneman-style phenotype). This is the
 * live "how do I feel right now" snapshot; it ticks continuously via
 * ODE and is mutated by event stimuli.
 *
 * Phase 1 only implements the two simplest axes — fatigue and attention —
 * because they're enough to drive a visible modulation change on the
 * avatar while keeping the first integration testable.
 */
export interface Phenotype {
  /**
   * Accumulates while the bot is actively processing (pose != 'idle'),
   * decays while truly idle. Range [0, 1]. Directly drives modulation:
   * tired → slower / lower-amplitude motion.
   */
  fatigue: number;
  /**
   * Rises on every incoming stimulus (e.g. new user message), decays
   * exponentially toward 0 during silence. Range [0, 1]. Reserved for
   * Phase 1 observability — not yet wired to modulation.
   */
  attention: number;
  /** Count of stimuli observed this session (for debug / HUD). */
  stimulusCount: number;
  /** `Date.now()` of the last observed stimulus, or undefined if none. */
  lastStimulusAt?: number;
}

/**
 * Stimulus events are the input side of the phenotype — every external
 * signal (message arrival, gift, silence, tease, …) becomes a stimulus
 * that the ODE consumes. Phase 1 only defines `message`; later phases
 * add `gift`, `silence`, etc., without breaking consumers.
 */
export interface MessageStimulus {
  kind: 'message';
  ts: number;
  userId?: string;
  groupId?: string;
}

export type Stimulus = MessageStimulus; // union grows in later phases.

/**
 * JSON-serializable snapshot of the phenotype + derived modulation, for
 * HUD display. Broadcast over `previewServer.updateStatus` every 1s.
 *
 * Kept flat + primitive-only so it round-trips through WS JSON without
 * custom encoding. Does NOT include the modulation provider reference
 * (not serialisable) — the modulation *values* are mirrored here.
 */
export interface MindStateSnapshot {
  enabled: boolean;
  personaId: PersonaId;
  phenotype: Phenotype;
  modulation: {
    intensityScale: number;
    speedScale: number;
    durationBias: number;
  };
  /** `Date.now()` when snapshot was produced. */
  capturedAt: number;
}

/**
 * MindConfig — merged from the `mind` section of `config.jsonc`.
 * Defaults live in `DEFAULT_MIND_CONFIG`; `mergeMindConfig()` fills gaps.
 */
export interface MindConfig {
  /** Master switch; when false the service is a no-op and all hooks skip. */
  enabled: boolean;
  /** Persona id to load. Phase 1 treats this as a label only. */
  personaId: PersonaId;
  /** Tick interval in ms. Default 1000 (1Hz). Lower = smoother HUD but more CPU. */
  tickMs: number;

  /** ODE time constants (see `ode.ts`). */
  ode: {
    /** Attention exponential decay time constant, in ms. Default 120_000 (2 min). */
    tauAttentionMs: number;
    /** Fatigue accrual rate while active (not idle), per ms. Default 5e-7 ≈ 1.0 over ~33 min. */
    fatigueAccrualPerMs: number;
    /** Fatigue rest decay rate while idle, per ms. Default 1e-6 ≈ full recovery in ~16 min. */
    fatigueRestDecayPerMs: number;
    /** Attention spike delta applied on every message stimulus. Default 0.3. */
    attentionSpikePerMessage: number;
  };

  /**
   * Modulation mapping — how phenotype numbers translate to avatar
   * modulation. Kept as config so the feel can be tuned without code
   * changes. Phase 1 only maps fatigue → intensity/speed.
   */
  modulation: {
    /**
     * Intensity reduction at maximum fatigue. 0.4 = tired avatar moves
     * at 60% intensity. Range [0, 1] (1.0 would silence all motion).
     */
    fatigueIntensityDrop: number;
    /**
     * Speed reduction at maximum fatigue. 0.3 = tired avatar moves at
     * ~77% speed (speedScale = 1 - 0.3 * fatigue).
     */
    fatigueSpeedDrop: number;
  };

  /**
   * Prompt-patch behaviour (Phase 2). Controls whether and when the
   * mind subsystem injects natural-language hints into the reply
   * pipeline's system prompt. Kept separate from `mind.enabled` so
   * A/B testing can isolate "modulation only" from "prompt-coloured".
   */
  promptPatch: {
    /**
     * Master switch. When false, prompt fragments are never emitted
     * even if `mind.enabled=true`. Defaults to true.
     */
    enabled: boolean;
    /** Below this fatigue level, no mood summary is injected. */
    fatigueMildMin: number;
    /** Between mild and moderate bands. */
    fatigueModerateMin: number;
    /** Above this, strongest-wording hint. */
    fatigueSevereMin: number;
  };
}

export const DEFAULT_MIND_CONFIG: MindConfig = {
  enabled: false,
  personaId: 'default',
  tickMs: 1000,
  ode: {
    tauAttentionMs: 120_000,
    fatigueAccrualPerMs: 5e-7,
    fatigueRestDecayPerMs: 1e-6,
    attentionSpikePerMessage: 0.3,
  },
  modulation: {
    fatigueIntensityDrop: 0.4,
    fatigueSpeedDrop: 0.3,
  },
  promptPatch: {
    enabled: true,
    fatigueMildMin: 0.3,
    fatigueModerateMin: 0.55,
    fatigueSevereMin: 0.8,
  },
};

/**
 * Merge raw JSONC config blob onto the defaults. Unknown fields are
 * dropped (defensive). Nested ode/modulation objects merge shallowly.
 *
 * Accepts `undefined` (no `mind` section) and returns defaults.
 */
export function mergeMindConfig(raw: Record<string, unknown> | undefined): MindConfig {
  const src = (raw ?? {}) as Partial<MindConfig>;
  const odeSrc = (src.ode ?? {}) as Partial<MindConfig['ode']>;
  const modSrc = (src.modulation ?? {}) as Partial<MindConfig['modulation']>;
  const ppSrc = (src.promptPatch ?? {}) as Partial<MindConfig['promptPatch']>;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_MIND_CONFIG.enabled,
    personaId: typeof src.personaId === 'string' && src.personaId ? src.personaId : DEFAULT_MIND_CONFIG.personaId,
    tickMs: numberOr(src.tickMs, DEFAULT_MIND_CONFIG.tickMs),
    ode: {
      tauAttentionMs: numberOr(odeSrc.tauAttentionMs, DEFAULT_MIND_CONFIG.ode.tauAttentionMs),
      fatigueAccrualPerMs: numberOr(odeSrc.fatigueAccrualPerMs, DEFAULT_MIND_CONFIG.ode.fatigueAccrualPerMs),
      fatigueRestDecayPerMs: numberOr(odeSrc.fatigueRestDecayPerMs, DEFAULT_MIND_CONFIG.ode.fatigueRestDecayPerMs),
      attentionSpikePerMessage: numberOr(
        odeSrc.attentionSpikePerMessage,
        DEFAULT_MIND_CONFIG.ode.attentionSpikePerMessage,
      ),
    },
    modulation: {
      fatigueIntensityDrop: numberOr(modSrc.fatigueIntensityDrop, DEFAULT_MIND_CONFIG.modulation.fatigueIntensityDrop),
      fatigueSpeedDrop: numberOr(modSrc.fatigueSpeedDrop, DEFAULT_MIND_CONFIG.modulation.fatigueSpeedDrop),
    },
    promptPatch: {
      enabled: typeof ppSrc.enabled === 'boolean' ? ppSrc.enabled : DEFAULT_MIND_CONFIG.promptPatch.enabled,
      fatigueMildMin: numberOr(ppSrc.fatigueMildMin, DEFAULT_MIND_CONFIG.promptPatch.fatigueMildMin),
      fatigueModerateMin: numberOr(ppSrc.fatigueModerateMin, DEFAULT_MIND_CONFIG.promptPatch.fatigueModerateMin),
      fatigueSevereMin: numberOr(ppSrc.fatigueSevereMin, DEFAULT_MIND_CONFIG.promptPatch.fatigueSevereMin),
    },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

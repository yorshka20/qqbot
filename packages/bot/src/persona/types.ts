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

import { type MessageSource, SOURCE_VALUES } from '@/conversation/sources';

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
export interface PersonaStateSnapshot {
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
 * PersonaConfig — merged from the `mind` section of `config.jsonc`.
 * Defaults live in `DEFAULT_PERSONA_CONFIG`; `mergePersonaConfig()` fills gaps.
 */
export interface PersonaConfig {
  /** Master switch; when false the service is a no-op and all hooks skip. */
  enabled: boolean;
  /** Persona id to load. Phase 1 treats this as a label only. */
  personaId: PersonaId;
  /** Root directory for persona-related on-disk assets (Bible, future Core DNA, …). Default './data/persona'. */
  dataDir: string;
  /** Tick interval in ms. Default 1000 (1Hz). Lower = smoother HUD but more CPU. */
  tickMs: number;

  /**
   * Master allow-list for which real-IM message sources drive **all**
   * mind-related effects: stimulus accrual (fatigue / attention),
   * onMessageComplete reflection / relationship update, and prompt
   * injection (when `promptPatch.applicableSources` is omitted).
   *
   * Default: `['qq-private', 'qq-group', 'discord']` (all real-IM).
   * Synthetic sources (avatar-cmd / bilibili-danmaku / idle-trigger /
   * bootstrap) are **always** excluded by separate logic — they don't
   * represent real users and would pollute mind state.
   *
   * Set to `['qq-private']` to test the full persona system in DM only.
   */
  applicableSources?: readonly import('../conversation/sources').MessageSource[];

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
    /** Whether to inject persona_identity / persona_boundaries blocks from CharacterBible. Default true. */
    injectBible: boolean;
    /** Max chars per Bible section when truncating for prompt budget. Default 800 (chars, not tokens). */
    bibleMaxCharsPerSection: number;
    /**
     * Phase 3.6: which message sources receive mind / persona injection.
     * When undefined, the producer falls back to its built-in default
     * (qq-private, qq-group, avatar-cmd, bilibili-danmaku). Override here
     * to e.g. silence mind in groups or extend coverage to idle-trigger.
     */
    applicableSources?: readonly MessageSource[];
  };

  /**
   * Autonomous wander (Phase 3). Periodic low-amplitude idle motion —
   * small glances, weight shifts, micro-steps — gated to neutral pose
   * so the bot never moves while speaking / listening / thinking.
   *
   * Suppressed when `mind.enabled=false` or `wander.enabled=false`. All
   * amplitudes are caps; each intent samples a random fraction in
   * [0.25, 1] of the cap, so typical motion is visibly subtle.
   */
  wander: {
    enabled: boolean;
    /** Minimum delay between wander attempts (ms). */
    intervalMinMs: number;
    /** Maximum delay between wander attempts (ms). */
    intervalMaxMs: number;
    /** After a wander finishes, wait at least this long before the next is eligible. */
    cooldownMs: number;
    /** Weights for the intent kinds — picked by weighted random each fire. */
    intents: {
      glance: number;
      look_around: number;
      shift_weight: number;
      micro_step: number;
      browse: number;
      /**
       * Weight for "play one random idle clip from `idleClipPool`". Folds
       * idle-motion-layer's interject scheduling into the unified wander
       * scheduler so wander steps and clip interjects share one cooldown
       * timer (mutex by design — only one fires per tick).
       */
      idle_clip: number;
    };
    /** Amplitude caps for generated motion. */
    amplitude: {
      maxTurnRad: number;
      maxStepMeters: number;
      maxStrafeMeters: number;
    };
    /**
     * Action names eligible for the `idle_clip` intent. Each entry should
     * resolve to a clip-kind action (variant pools like `vrm_idle_loop` are
     * supported — the action map's own random pick handles per-clip
     * selection within the pool). Defaults to `['vrm_idle_loop']`.
     */
    idleClipPool: string[];
  };

  /**
   * Autonomous trigger (Phase 3). Translates long-running phenotype state
   * into discrete avatar actions: fatigue → yawn-style refresh clip on a
   * randomised cooldown; valence → emotion drift state machine (sad /
   * neutral / happy bands with hysteresis). Requires avatar enabled.
   *
   * Valence is read defensively (`phenotype.valence ?? 0`) because Phase 1
   * Phenotype does not carry the field yet — production triggers are no-ops
   * until valence lands in a future ticket.
   */
  autonomousTrigger: {
    enabled: boolean;
    yawn: {
      fatigueThreshold: number;
      cooldownMinMs: number;
      cooldownMaxMs: number;
      actionName: string;
      intensity: number;
    };
    valenceDrift: {
      negativeThreshold: number;
      positiveThreshold: number;
      neutralLowMin: number;
      neutralHighMax: number;
      sadEmotionName: string;
      happyEmotionName: string;
      neutralEmotionName: string;
      sadIntensityMin: number;
      sadIntensityMax: number;
      sadIntensityFactor: number;
      happyIntensityMin: number;
      happyIntensityMax: number;
      happyIntensityFactor: number;
    };
  };

  /**
   * Reflection agent-loop configuration (System 2 tool-equipping).
   * When toolEquipped=true and maxToolRounds>0, ReflectionEngine runs a
   * multi-round LLM tool loop using reflection-scope tools before producing
   * the final ReflectionOutput JSON.  Falls back to single-call behavior
   * when toolEquipped=false or maxToolRounds=0.
   */
  reflection?: {
    /** Enable the agent-loop path. Default: false. */
    toolEquipped?: boolean;
    /**
     * Maximum tool-use rounds per reflection cycle.
     * Only used when toolEquipped=true.  Default: 4.
     */
    maxToolRounds?: number;
  };
}

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  enabled: false,
  personaId: 'default',
  dataDir: './data/persona',
  tickMs: 1000,
  applicableSources: ['qq-private', 'qq-group', 'discord'],
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
    injectBible: true,
    bibleMaxCharsPerSection: 800,
  },
  wander: {
    enabled: true,
    intervalMinMs: 10_000,
    intervalMaxMs: 20_000,
    cooldownMs: 10_000,
    intents: {
      // idle_clip dominates the weight — most ticks should play an idle
      // clip variant (subtle bone motion, no translation). Wander steps
      // (gaze / look-around / micro-step / browse) sprinkle in for spatial
      // randomness. Tuned so the avatar reads as "mostly still + occasional
      // motion" rather than "constant procedural fidget".
      glance: 0.15,
      look_around: 0.1,
      shift_weight: 0.08,
      micro_step: 0.05,
      browse: 0.02,
      idle_clip: 0.6,
    },
    amplitude: {
      maxTurnRad: Math.PI / 6, // ~30°
      maxStepMeters: 0.25,
      maxStrafeMeters: 0.2,
    },
    idleClipPool: ['vrm_idle_loop'],
  },
  autonomousTrigger: {
    enabled: true,
    yawn: {
      fatigueThreshold: 0.8,
      cooldownMinMs: 300_000,
      cooldownMaxMs: 600_000,
      actionName: 'vrm_emotion_refresh',
      intensity: 0.6,
    },
    valenceDrift: {
      negativeThreshold: -0.3,
      positiveThreshold: 0.5,
      neutralLowMin: -0.1,
      neutralHighMax: 0.3,
      sadEmotionName: 'emotion_sad',
      happyEmotionName: 'emotion_smile',
      neutralEmotionName: 'emotion_thinking',
      sadIntensityMin: 0.2,
      sadIntensityMax: 0.5,
      sadIntensityFactor: 0.6,
      happyIntensityMin: 0.3,
      happyIntensityMax: 0.6,
      happyIntensityFactor: 0.5,
    },
  },
  reflection: {
    toolEquipped: false,
    maxToolRounds: 4,
  },
};

/** Minimal shape exported for `wander/*` consumers without a full re-import. */
export type WanderConfig = PersonaConfig['wander'];

/**
 * Merge raw JSONC config blob onto the defaults. Unknown fields are
 * dropped (defensive). Nested ode/modulation objects merge shallowly.
 *
 * Accepts `undefined` (no `mind` section) and returns defaults.
 */
export function mergePersonaConfig(raw: Record<string, unknown> | undefined): PersonaConfig {
  const src = (raw ?? {}) as Partial<PersonaConfig>;
  const odeSrc = (src.ode ?? {}) as Partial<PersonaConfig['ode']>;
  const modSrc = (src.modulation ?? {}) as Partial<PersonaConfig['modulation']>;
  const ppSrc = (src.promptPatch ?? {}) as Partial<PersonaConfig['promptPatch']>;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_PERSONA_CONFIG.enabled,
    personaId: typeof src.personaId === 'string' && src.personaId ? src.personaId : DEFAULT_PERSONA_CONFIG.personaId,
    dataDir: typeof src.dataDir === 'string' && src.dataDir ? src.dataDir : DEFAULT_PERSONA_CONFIG.dataDir,
    tickMs: numberOr(src.tickMs, DEFAULT_PERSONA_CONFIG.tickMs),
    applicableSources: Array.isArray(src.applicableSources)
      ? (src.applicableSources as readonly import('../conversation/sources').MessageSource[])
      : DEFAULT_PERSONA_CONFIG.applicableSources,
    ode: {
      tauAttentionMs: numberOr(odeSrc.tauAttentionMs, DEFAULT_PERSONA_CONFIG.ode.tauAttentionMs),
      fatigueAccrualPerMs: numberOr(odeSrc.fatigueAccrualPerMs, DEFAULT_PERSONA_CONFIG.ode.fatigueAccrualPerMs),
      fatigueRestDecayPerMs: numberOr(odeSrc.fatigueRestDecayPerMs, DEFAULT_PERSONA_CONFIG.ode.fatigueRestDecayPerMs),
      attentionSpikePerMessage: numberOr(
        odeSrc.attentionSpikePerMessage,
        DEFAULT_PERSONA_CONFIG.ode.attentionSpikePerMessage,
      ),
    },
    modulation: {
      fatigueIntensityDrop: numberOr(
        modSrc.fatigueIntensityDrop,
        DEFAULT_PERSONA_CONFIG.modulation.fatigueIntensityDrop,
      ),
      fatigueSpeedDrop: numberOr(modSrc.fatigueSpeedDrop, DEFAULT_PERSONA_CONFIG.modulation.fatigueSpeedDrop),
    },
    promptPatch: {
      enabled: typeof ppSrc.enabled === 'boolean' ? ppSrc.enabled : DEFAULT_PERSONA_CONFIG.promptPatch.enabled,
      fatigueMildMin: numberOr(ppSrc.fatigueMildMin, DEFAULT_PERSONA_CONFIG.promptPatch.fatigueMildMin),
      fatigueModerateMin: numberOr(ppSrc.fatigueModerateMin, DEFAULT_PERSONA_CONFIG.promptPatch.fatigueModerateMin),
      fatigueSevereMin: numberOr(ppSrc.fatigueSevereMin, DEFAULT_PERSONA_CONFIG.promptPatch.fatigueSevereMin),
      injectBible:
        typeof ppSrc.injectBible === 'boolean' ? ppSrc.injectBible : DEFAULT_PERSONA_CONFIG.promptPatch.injectBible,
      bibleMaxCharsPerSection: numberOr(
        ppSrc.bibleMaxCharsPerSection,
        DEFAULT_PERSONA_CONFIG.promptPatch.bibleMaxCharsPerSection,
      ),
      applicableSources: Array.isArray(ppSrc.applicableSources)
        ? (ppSrc.applicableSources.filter(
            (s): s is MessageSource => typeof s === 'string' && SOURCE_VALUES.includes(s as MessageSource),
          ) as readonly MessageSource[])
        : undefined,
    },
    wander: mergeWanderConfig(src.wander),
    autonomousTrigger: mergeAutonomousTriggerConfig(src.autonomousTrigger),
    reflection: mergeReflectionConfig(src.reflection),
  };
}

function mergeWanderConfig(raw: unknown): PersonaConfig['wander'] {
  const src = (raw ?? {}) as Partial<PersonaConfig['wander']>;
  const intentsSrc = (src.intents ?? {}) as Partial<PersonaConfig['wander']['intents']>;
  const ampSrc = (src.amplitude ?? {}) as Partial<PersonaConfig['wander']['amplitude']>;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_PERSONA_CONFIG.wander.enabled,
    intervalMinMs: numberOr(src.intervalMinMs, DEFAULT_PERSONA_CONFIG.wander.intervalMinMs),
    intervalMaxMs: numberOr(src.intervalMaxMs, DEFAULT_PERSONA_CONFIG.wander.intervalMaxMs),
    cooldownMs: numberOr(src.cooldownMs, DEFAULT_PERSONA_CONFIG.wander.cooldownMs),
    intents: {
      glance: numberOr(intentsSrc.glance, DEFAULT_PERSONA_CONFIG.wander.intents.glance),
      look_around: numberOr(intentsSrc.look_around, DEFAULT_PERSONA_CONFIG.wander.intents.look_around),
      shift_weight: numberOr(intentsSrc.shift_weight, DEFAULT_PERSONA_CONFIG.wander.intents.shift_weight),
      micro_step: numberOr(intentsSrc.micro_step, DEFAULT_PERSONA_CONFIG.wander.intents.micro_step),
      browse: numberOr(intentsSrc.browse, DEFAULT_PERSONA_CONFIG.wander.intents.browse),
      idle_clip: numberOr(intentsSrc.idle_clip, DEFAULT_PERSONA_CONFIG.wander.intents.idle_clip),
    },
    amplitude: {
      maxTurnRad: numberOr(ampSrc.maxTurnRad, DEFAULT_PERSONA_CONFIG.wander.amplitude.maxTurnRad),
      maxStepMeters: numberOr(ampSrc.maxStepMeters, DEFAULT_PERSONA_CONFIG.wander.amplitude.maxStepMeters),
      maxStrafeMeters: numberOr(ampSrc.maxStrafeMeters, DEFAULT_PERSONA_CONFIG.wander.amplitude.maxStrafeMeters),
    },
    idleClipPool: Array.isArray(src.idleClipPool)
      ? src.idleClipPool.filter((s): s is string => typeof s === 'string')
      : [...DEFAULT_PERSONA_CONFIG.wander.idleClipPool],
  };
}

function mergeAutonomousTriggerConfig(raw: unknown): PersonaConfig['autonomousTrigger'] {
  const src = (raw ?? {}) as Partial<PersonaConfig['autonomousTrigger']>;
  const yawnSrc = (src.yawn ?? {}) as Partial<PersonaConfig['autonomousTrigger']['yawn']>;
  const vdSrc = (src.valenceDrift ?? {}) as Partial<PersonaConfig['autonomousTrigger']['valenceDrift']>;
  const D = DEFAULT_PERSONA_CONFIG.autonomousTrigger;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : D.enabled,
    yawn: {
      fatigueThreshold: numberOr(yawnSrc.fatigueThreshold, D.yawn.fatigueThreshold),
      cooldownMinMs: numberOr(yawnSrc.cooldownMinMs, D.yawn.cooldownMinMs),
      cooldownMaxMs: numberOr(yawnSrc.cooldownMaxMs, D.yawn.cooldownMaxMs),
      actionName: typeof yawnSrc.actionName === 'string' && yawnSrc.actionName ? yawnSrc.actionName : D.yawn.actionName,
      intensity: numberOr(yawnSrc.intensity, D.yawn.intensity),
    },
    valenceDrift: {
      negativeThreshold: numberOr(vdSrc.negativeThreshold, D.valenceDrift.negativeThreshold),
      positiveThreshold: numberOr(vdSrc.positiveThreshold, D.valenceDrift.positiveThreshold),
      neutralLowMin: numberOr(vdSrc.neutralLowMin, D.valenceDrift.neutralLowMin),
      neutralHighMax: numberOr(vdSrc.neutralHighMax, D.valenceDrift.neutralHighMax),
      sadEmotionName:
        typeof vdSrc.sadEmotionName === 'string' && vdSrc.sadEmotionName
          ? vdSrc.sadEmotionName
          : D.valenceDrift.sadEmotionName,
      happyEmotionName:
        typeof vdSrc.happyEmotionName === 'string' && vdSrc.happyEmotionName
          ? vdSrc.happyEmotionName
          : D.valenceDrift.happyEmotionName,
      neutralEmotionName:
        typeof vdSrc.neutralEmotionName === 'string' && vdSrc.neutralEmotionName
          ? vdSrc.neutralEmotionName
          : D.valenceDrift.neutralEmotionName,
      sadIntensityMin: numberOr(vdSrc.sadIntensityMin, D.valenceDrift.sadIntensityMin),
      sadIntensityMax: numberOr(vdSrc.sadIntensityMax, D.valenceDrift.sadIntensityMax),
      sadIntensityFactor: numberOr(vdSrc.sadIntensityFactor, D.valenceDrift.sadIntensityFactor),
      happyIntensityMin: numberOr(vdSrc.happyIntensityMin, D.valenceDrift.happyIntensityMin),
      happyIntensityMax: numberOr(vdSrc.happyIntensityMax, D.valenceDrift.happyIntensityMax),
      happyIntensityFactor: numberOr(vdSrc.happyIntensityFactor, D.valenceDrift.happyIntensityFactor),
    },
  };
}

function mergeReflectionConfig(raw: unknown): PersonaConfig['reflection'] {
  const src = (raw ?? {}) as Partial<NonNullable<PersonaConfig['reflection']>>;
  return {
    toolEquipped: typeof src.toolEquipped === 'boolean' ? src.toolEquipped : false,
    maxToolRounds: numberOr(src.maxToolRounds, 4),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

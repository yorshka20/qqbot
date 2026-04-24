/**
 * Avatar-side contract for mind-system integration.
 *
 * The avatar package does **not** own or import the mind module — mind lives
 * in `packages/bot/src/mind/` and injects a `MindModulationProvider` into
 * `AvatarService` at bootstrap. When no provider is registered,
 * `AvatarService` falls back to `IDENTITY_MODULATION` and behaves exactly as
 * it did pre-mind-system (full backward compat).
 *
 * The structure is intentionally nested by *pipeline injection point*
 * (amplitude / timing / …), not by personality trait. See
 * `.claude-learnings/mind.md` §PersonaModulation for the rationale.
 *
 * Phase 1 only populates `amplitude.intensityScale` + `timing.speedScale`.
 * Every other field is optional and ignored by the avatar package today —
 * consumers are free to emit them for forward-compat, and later phases will
 * wire them to new avatar hooks (spatial bias layer, action variant weights,
 * ambient gain bus, etc.).
 */

import type { ChannelGroup } from '../channels/groups';

export type ActionCategory = 'emotion' | 'movement' | 'micro';

/**
 * A snapshot of the current persona's expressive modulation surface.
 * Avatar consumes this every time it queues an LLM-authored tag.
 *
 * All scale fields are *multiplicative* around `1.0` (identity). A field
 * of `0.7` attenuates, `1.3` amplifies. Values ≤ 0 are clamped to a small
 * positive floor to avoid multiply-by-zero dead channels.
 */
export interface MindModulation {
  amplitude: {
    /** Global multiplier on LLM-authored intensity. Default 1.0. */
    intensityScale: number;
    /** Per-category multiplier (emotion / movement / micro). Optional. */
    perCategoryScale?: Partial<Record<ActionCategory, number>>;
    /**
     * Per-channel-group multiplier. Applied at the PersonaPostureLayer /
     * compiler targeting stage — Phase 1 exposes the field for planning
     * but does not consume it yet.
     */
    perChannelGroupScale?: Partial<Record<ChannelGroup, number>>;
  };
  timing: {
    /**
     * Speed multiplier on envelope duration. `>1.0` = faster (shorter
     * duration), `<1.0` = slower. Duration is computed as
     * `baseDuration / clamp(speedScale, 0.1, 10)`. Default 1.0.
     */
    speedScale: number;
    /** Additive duration offset in ms, applied after speedScale. Default 0. */
    durationBias?: number;
    /**
     * Multiplier on the compiler's random jitter magnitudes (duration +
     * intensity). Default 1.0. Set to 0 for deterministic playback under
     * a stable persona state (useful for A/B tuning).
     */
    jitterScale?: number;
    /** Multiplier on IdleMotionLayer gap duration. Reserved for Phase 3. */
    idleGapScale?: number;
  };
  /**
   * Reserved surfaces for later phases. Defined here so producers can
   * populate them without type errors; avatar ignores them today.
   */
  spatial?: {
    gazeContactPreference?: number;
    postureLean?: number;
    headTiltBias?: number;
  };
  actionPref?: {
    /** Per-action variant selection weights. Indexed by declared order. */
    variantWeights?: Record<string, readonly number[]>;
    forbiddenActions?: readonly string[];
  };
  ambient?: {
    gainScale?: number;
  };
}

/**
 * Neutral modulation — identity on every axis. Used as the fallback when no
 * `MindModulationProvider` is registered.
 */
export const IDENTITY_MODULATION: MindModulation = Object.freeze({
  amplitude: { intensityScale: 1.0 },
  timing: { speedScale: 1.0 },
});

/**
 * Per-call context available when the avatar asks the mind for a modulation
 * snapshot. Lightweight on purpose — the provider can consult its own
 * MindState without receiving the full conversation context.
 */
export interface ModulationContext {
  /** Action name being enqueued, if known. */
  actionName?: string;
  /** Action category from the action map, if known. */
  category?: ActionCategory;
  /** Upstream user id (for relationship-scoped modulation). */
  userId?: string;
}

/**
 * The interface `AvatarService.setMindModulationProvider()` accepts. Mind
 * implements this and hands the service an instance at bootstrap.
 *
 * `getModulation` must be cheap (no I/O) — it runs on every tag enqueue.
 */
export interface MindModulationProvider {
  getModulation(ctx?: ModulationContext): MindModulation;
}

/**
 * Clamp a scale multiplier to a safe non-negative range. Used by the avatar
 * consumer to guarantee the compiler never sees non-finite or negative
 * values from a badly-authored provider.
 *
 * Zero is preserved — some axes (e.g. `jitterScale = 0` for deterministic
 * playback, `intensityScale = 0` to silence an expression) legitimately
 * want zero. Callers whose usage involves division (e.g. duration ÷
 * speedScale) must apply their own local floor before dividing.
 */
export function sanitizeScale(value: number | undefined, fallback = 1.0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

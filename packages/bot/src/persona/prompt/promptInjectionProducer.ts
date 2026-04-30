/**
 * Phase 3.6: factory for the mind PromptInjectionProducer.
 *
 * Extracted into its own module so:
 *   1. PersonaInitializer can call it without runtime-importing the registry class.
 *   2. Unit tests can exercise the producer in isolation with a fake PersonaService.
 */

import type { PromptInjectionProducer } from '@/conversation/promptInjection/types';
import type { MessageSource } from '@/conversation/sources';
import type { PersonaConfig } from '@/persona/types';

/** Minimal subset of PersonaService required by the producers. */
export interface PersonaServiceLike {
  isEnabled(): boolean;
  /** Combined fragment — kept for back-compat with non-pipeline callers / tests. */
  getPromptPatchFragmentAsync(opts?: { userId?: string }): Promise<string>;
  /** Stable identity blocks — placed at the cache-friendly front of system prompt. */
  getStableFragmentAsync?(opts?: { userId?: string }): Promise<string>;
  /** Volatile state blocks — placed at the back where per-message churn is fine. */
  getVolatileFragmentAsync?(opts?: { userId?: string }): Promise<string>;
}

/**
 * Priority cutoff for PromptAssemblyStage:
 *   - `priority ≤ STABLE_PRIORITY_MAX` (≤ 49): placed BEFORE scene template (cache-friendly front)
 *   - `priority > STABLE_PRIORITY_MAX`: placed AFTER scene template (volatile back)
 */
export const STABLE_PRIORITY_MAX = 49;
/** Stable persona identity (Bible-derived, doesn't change per message). */
const PRIORITY_PERSONA_STABLE = 10;
/** Volatile persona state (mood / relationship / tone — recomputed per message). */
const PRIORITY_PERSONA_VOLATILE = 60;

const FALLBACK_SYNTHETIC_INCLUSIVE: readonly MessageSource[] = [
  'qq-private',
  'qq-group',
  'avatar-cmd',
  'bilibili-danmaku',
];

/**
 * Resolution order for the mind producer's `applicableSources`:
 *   1. `promptPatch.applicableSources` if set — fine-grained prompt-only override
 *   2. `mind.applicableSources` if set — master mind allow-list
 *      (extended with avatar-cmd / bilibili-danmaku to keep avatar-driven
 *      LLM paths personalised, since those don't appear in the master list
 *      which only governs real-IM stimulus / reflection)
 *   3. Hard-coded fallback (synthetic-inclusive default)
 */
function resolveProducerSources(config: PersonaConfig): readonly MessageSource[] {
  if (config.promptPatch.applicableSources && config.promptPatch.applicableSources.length > 0) {
    return config.promptPatch.applicableSources;
  }
  const master = config.applicableSources;
  if (master && master.length > 0) {
    const set = new Set<MessageSource>(master);
    set.add('avatar-cmd');
    set.add('bilibili-danmaku');
    return Array.from(set);
  }
  return FALLBACK_SYNTHETIC_INCLUSIVE;
}

/**
 * Legacy single-producer factory — emits both stable + volatile persona
 * blocks as one fragment at priority 10. Kept so existing tests / callers
 * that wired only one producer keep working.
 *
 * Production reply pipeline should register `createPersonaStableProducer`
 * + `createPersonaVolatileProducer` separately so PromptAssemblyStage can
 * place stable blocks at the cache-friendly front and volatile blocks at
 * the back. See `PersonaInitializer`.
 */
export function createPersonaPromptInjectionProducer(deps: {
  personaService: PersonaServiceLike;
  config: PersonaConfig;
}): PromptInjectionProducer {
  const { personaService, config } = deps;
  return {
    name: 'persona',
    applicableSources: resolveProducerSources(config),
    priority: PRIORITY_PERSONA_STABLE,
    async produce(ctx) {
      if (!personaService.isEnabled()) return null;
      if (!config.promptPatch.enabled) return null;
      const userId = ctx.userId;
      const fragment = await personaService.getPromptPatchFragmentAsync(userId ? { userId } : undefined);
      if (!fragment) return null;
      return { producerName: 'persona', priority: PRIORITY_PERSONA_STABLE, fragment };
    },
  };
}

/**
 * Stable producer — only emits the Bible-derived `<persona_identity>` +
 * `<persona_boundaries>` blocks. Stable across messages for a given
 * persona, so PromptAssemblyStage places it BEFORE the scene template
 * (cache-friendly front) at priority `PRIORITY_PERSONA_STABLE`.
 */
export function createPersonaStableProducer(deps: {
  personaService: PersonaServiceLike;
  config: PersonaConfig;
}): PromptInjectionProducer {
  const { personaService, config } = deps;
  return {
    name: 'persona-stable',
    applicableSources: resolveProducerSources(config),
    priority: PRIORITY_PERSONA_STABLE,
    async produce(ctx) {
      if (!personaService.isEnabled()) return null;
      if (!config.promptPatch.enabled) return null;
      if (!personaService.getStableFragmentAsync) return null;
      const userId = ctx.userId;
      const fragment = await personaService.getStableFragmentAsync(userId ? { userId } : undefined);
      if (!fragment) return null;
      return { producerName: 'persona-stable', priority: PRIORITY_PERSONA_STABLE, fragment };
    },
  };
}

/**
 * Volatile producer — emits per-message state blocks (`<mind_state>` /
 * `<relationship_state>` / `<tone_state>`). Recomputed every message;
 * placed AFTER the scene template at priority `PRIORITY_PERSONA_VOLATILE`
 * so per-message churn doesn't break upstream prompt cache prefixes.
 */
export function createPersonaVolatileProducer(deps: {
  personaService: PersonaServiceLike;
  config: PersonaConfig;
}): PromptInjectionProducer {
  const { personaService, config } = deps;
  return {
    name: 'persona-volatile',
    applicableSources: resolveProducerSources(config),
    priority: PRIORITY_PERSONA_VOLATILE,
    async produce(ctx) {
      if (!personaService.isEnabled()) return null;
      if (!config.promptPatch.enabled) return null;
      if (!personaService.getVolatileFragmentAsync) return null;
      const userId = ctx.userId;
      const fragment = await personaService.getVolatileFragmentAsync(userId ? { userId } : undefined);
      if (!fragment) return null;
      return { producerName: 'persona-volatile', priority: PRIORITY_PERSONA_VOLATILE, fragment };
    },
  };
}

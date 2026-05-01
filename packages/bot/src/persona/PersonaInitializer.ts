/**
 * PersonaInitializer — builds the mind subsystem components.
 *
 * Mirrors the `AgendaInitializer` pattern: a static `initialize()` that
 * returns a `PersonaComponents` bag which the caller registers with the DI
 * container + wires into the rest of the system.
 *
 * Phase 1 is thin because most of the logic lives in `PersonaService` and
 * `ode.ts`; the initializer just connects the config + event bus.
 */

import type { InternalEventBus } from '@/agenda/InternalEventBus';
import type { PromptInjectionRegistry } from '@/conversation/promptInjection/PromptInjectionRegistry';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { PersonaModulationAdapter } from '@/integrations/avatar/services/PersonaModulationAdapter';
import { logger } from '@/utils/logger';
import { type CharacterBible, loadCharacterBible } from './data/CharacterBibleLoader';
import { type CoreDNA, loadCoreDNA } from './data/CoreDNALoader';
import { PersonaService } from './PersonaService';
import {
  createPersonaStableProducer,
  createPersonaVolatileProducer,
} from './prompt/promptInjectionProducer';
import { mergePersonaConfig, type PersonaConfig } from './types';

export interface PersonaComponents {
  personaService: PersonaService;
  modulationProvider: PersonaModulationAdapter;
  config: PersonaConfig;
}

function countNonEmptySections(bible: CharacterBible): number {
  return [bible.selfConcept, bible.voice, bible.triggersRaw, bible.reflexesRaw, bible.boundaries, bible.lore].filter(
    (s) => s.length > 0,
  ).length;
}

/**
 * Three-layer priority merge: user-config > Core DNA > DEFAULT_PERSONA_CONFIG.
 * Scope kept narrow this ticket: only fatigue drop coefficients are merged.
 * Other Core DNA fields are read directly via personaService.getCorePersona() by
 * adapters/ode helpers — see ticket §备注 三层优先级 for the降级方案 we adopted.
 */
function applyCoreDnaToConfig(
  config: PersonaConfig,
  dna: CoreDNA,
  raw: Record<string, unknown> | undefined,
): PersonaConfig {
  const userMod = (raw?.modulation ?? {}) as Partial<PersonaConfig['modulation']>;
  return {
    ...config,
    modulation: {
      fatigueIntensityDrop:
        userMod.fatigueIntensityDrop !== undefined
          ? config.modulation.fatigueIntensityDrop
          : dna.emotion.fatigueIntensityDrop,
      fatigueSpeedDrop:
        userMod.fatigueSpeedDrop !== undefined ? config.modulation.fatigueSpeedDrop : dna.emotion.fatigueSpeedDrop,
    },
  };
}

export class PersonaInitializer {
  static async initialize(deps: {
    rawConfig: Record<string, unknown> | undefined;
    internalEventBus: InternalEventBus;
  }): Promise<PersonaComponents> {
    const baseConfig = mergePersonaConfig(deps.rawConfig);
    const dna = await loadCoreDNA({ dataDir: baseConfig.dataDir, personaId: baseConfig.personaId });
    const config = applyCoreDnaToConfig(baseConfig, dna, deps.rawConfig);
    logger.info(
      `[PersonaInitializer] Mind system ${config.enabled ? 'enabled' : 'disabled'} | persona=${config.personaId} tickMs=${config.tickMs}`,
    );
    const personaService = new PersonaService(config, deps.internalEventBus);

    const bible = await loadCharacterBible({ dataDir: config.dataDir, personaId: config.personaId });
    personaService.setCharacterBible(bible);
    personaService.setCorePersona(dna);
    const nonEmptySections = countNonEmptySections(bible);
    logger.info(
      `[PersonaService] character bible loaded | persona=${config.personaId} | sections=${nonEmptySections}/6 | rawBytes=${bible.raw.length}`,
    );

    const modulationProvider = new PersonaModulationAdapter(personaService);

    // Phase 3.6: register persona as PromptInjectionProducers so all sources
    // (qq-private, qq-group, avatar-cmd, bilibili-danmaku, etc.) get persona
    // injection through the unified registry rather than the old per-pipeline hook.
    //
    // Split into TWO producers (stable + volatile) so PromptAssemblyStage can
    // place stable identity blocks at the cache-friendly front of the system
    // prompt and volatile mind state at the back — see
    // STABLE_PRIORITY_MAX in promptInjectionProducer.ts.
    // PROMPT_INJECTION_REGISTRY is required (DITokens.ts) — registered by
    // bootstrap before ConversationInitializer runs.
    const registry = getContainer().resolve<PromptInjectionRegistry>(DITokens.PROMPT_INJECTION_REGISTRY);
    registry.register(createPersonaStableProducer({ personaService, config }));
    registry.register(createPersonaVolatileProducer({ personaService, config }));

    return { personaService, modulationProvider, config };
  }
}

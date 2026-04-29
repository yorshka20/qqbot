/**
 * MindInitializer — builds the mind subsystem components.
 *
 * Mirrors the `AgendaInitializer` pattern: a static `initialize()` that
 * returns a `MindComponents` bag which the caller registers with the DI
 * container + wires into the rest of the system.
 *
 * Phase 1 is thin because most of the logic lives in `MindService` and
 * `ode.ts`; the initializer just connects the config + event bus.
 */

import type { InternalEventBus } from '@/agenda/InternalEventBus';
import type { PromptInjectionRegistry } from '@/conversation/promptInjection/PromptInjectionRegistry';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { MindModulationAdapter } from './MindModulationAdapter';
import { MindService } from './MindService';
import { type CharacterBible, loadCharacterBible } from './personaStore/CharacterBibleLoader';
import { type CoreDNA, loadCoreDNA } from './personaStore/CoreDNALoader';
import { createMindPromptInjectionProducer } from './promptInjectionProducer';
import { type MindConfig, mergeMindConfig } from './types';

export interface MindComponents {
  mindService: MindService;
  modulationProvider: MindModulationAdapter;
  config: MindConfig;
}

function countNonEmptySections(bible: CharacterBible): number {
  return [bible.selfConcept, bible.voice, bible.triggersRaw, bible.reflexesRaw, bible.boundaries, bible.lore].filter(
    (s) => s.length > 0,
  ).length;
}

/**
 * Three-layer priority merge: user-config > Core DNA > DEFAULT_MIND_CONFIG.
 * Scope kept narrow this ticket: only fatigue drop coefficients are merged.
 * Other Core DNA fields are read directly via mindService.getCorePersona() by
 * adapters/ode helpers — see ticket §备注 三层优先级 for the降级方案 we adopted.
 */
function applyCoreDnaToConfig(config: MindConfig, dna: CoreDNA, raw: Record<string, unknown> | undefined): MindConfig {
  const userMod = (raw?.modulation ?? {}) as Partial<MindConfig['modulation']>;
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

export class MindInitializer {
  static async initialize(deps: {
    rawConfig: Record<string, unknown> | undefined;
    internalEventBus: InternalEventBus;
  }): Promise<MindComponents> {
    const baseConfig = mergeMindConfig(deps.rawConfig);
    const dna = await loadCoreDNA({ dataDir: baseConfig.dataDir, personaId: baseConfig.personaId });
    const config = applyCoreDnaToConfig(baseConfig, dna, deps.rawConfig);
    logger.info(
      `[MindInitializer] Mind system ${config.enabled ? 'enabled' : 'disabled'} | persona=${config.personaId} tickMs=${config.tickMs}`,
    );
    const mindService = new MindService(config, deps.internalEventBus);

    const bible = await loadCharacterBible({ dataDir: config.dataDir, personaId: config.personaId });
    mindService.setCharacterBible(bible);
    mindService.setCorePersona(dna);
    const nonEmptySections = countNonEmptySections(bible);
    logger.info(
      `[MindService] character bible loaded | persona=${config.personaId} | sections=${nonEmptySections}/6 | rawBytes=${bible.raw.length}`,
    );

    const modulationProvider = new MindModulationAdapter(mindService);

    // Phase 3.6: register mind as a PromptInjectionProducer so all sources
    // (qq-private, qq-group, avatar-cmd, bilibili-danmaku, etc.) get persona
    // injection through the unified registry rather than the old per-pipeline hook.
    try {
      const container = getContainer();
      if (container.isRegistered(DITokens.PROMPT_INJECTION_REGISTRY)) {
        const registry = container.resolve<PromptInjectionRegistry>(DITokens.PROMPT_INJECTION_REGISTRY);
        const producer = createMindPromptInjectionProducer({ mindService, config });
        registry.register(producer);
      } else {
        logger.warn(
          '[MindInitializer] PromptInjectionRegistry not registered — mind prompt injection skipped (avatar-only / minimal bootstrap?)',
        );
      }
    } catch (err) {
      logger.warn('[MindInitializer] failed to register mind PromptInjectionProducer (non-fatal):', err);
    }

    return { mindService, modulationProvider, config };
  }
}

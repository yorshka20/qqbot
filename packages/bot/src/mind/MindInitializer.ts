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
import { logger } from '@/utils/logger';
import { MindModulationAdapter } from './MindModulationAdapter';
import { MindService } from './MindService';
import { type CharacterBible, loadCharacterBible } from './personaStore/CharacterBibleLoader';
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

export class MindInitializer {
  static async initialize(deps: {
    rawConfig: Record<string, unknown> | undefined;
    internalEventBus: InternalEventBus;
  }): Promise<MindComponents> {
    const config = mergeMindConfig(deps.rawConfig);
    logger.info(
      `[MindInitializer] Mind system ${config.enabled ? 'enabled' : 'disabled'} | persona=${config.personaId} tickMs=${config.tickMs}`,
    );
    const mindService = new MindService(config, deps.internalEventBus);

    const bible = await loadCharacterBible({ dataDir: config.dataDir, personaId: config.personaId });
    mindService.setCharacterBible(bible);
    const nonEmptySections = countNonEmptySections(bible);
    logger.info(
      `[MindService] character bible loaded | persona=${config.personaId} | sections=${nonEmptySections}/6 | rawBytes=${bible.raw.length}`,
    );

    const modulationProvider = new MindModulationAdapter(mindService);
    return { mindService, modulationProvider, config };
  }
}

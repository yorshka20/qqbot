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
import { type MindConfig, mergeMindConfig } from './types';

export interface MindComponents {
  mindService: MindService;
  modulationProvider: MindModulationAdapter;
  config: MindConfig;
}

export class MindInitializer {
  static initialize(deps: {
    rawConfig: Record<string, unknown> | undefined;
    internalEventBus: InternalEventBus;
  }): MindComponents {
    const config = mergeMindConfig(deps.rawConfig);
    logger.info(
      `[MindInitializer] Mind system ${config.enabled ? 'enabled' : 'disabled'} | persona=${config.personaId} tickMs=${config.tickMs}`,
    );
    const mindService = new MindService(config, deps.internalEventBus);
    const modulationProvider = new MindModulationAdapter(mindService);
    return { mindService, modulationProvider, config };
  }
}

// FanoutInitializer — registers every fan-out in FANOUT_CONTEXTS and builds the FanoutManager.
//
// Runs before the agenda (whose `action fanout` handler needs the manager) and before
// plugins load (they resolve a fan-out class and register their tasks on it in onEnable).
// Every fan-out and FanoutServices are DI singletons, so a plugin resolving
// GroupDayFanout gets the instance the manager runs.

import type { DIContainer } from '@/core/DIContainer';
import { FANOUT_CONTEXTS } from './contexts';
import { FanoutManager } from './core/FanoutManager';
import { FanoutServices } from './core/FanoutServices';

export class FanoutInitializer {
  static initialize(container: DIContainer): FanoutManager {
    container.registerSingleton(FanoutServices);
    const manager = new FanoutManager();
    for (const type of FANOUT_CONTEXTS) {
      container.registerSingleton(type);
      manager.register(container.resolve(type));
    }
    return manager;
  }
}

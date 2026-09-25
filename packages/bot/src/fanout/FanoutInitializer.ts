// FanoutInitializer — exposes every fan-out in FANOUT_CONTEXTS to the FanoutManager,
// which receives them through @injectAll(DITokens.FANOUT_CONTEXTS).
//
// Each fan-out is a class-keyed singleton, so a plugin resolving GroupDayFanout and the
// manager's lookup by name reach the same instance, whichever is resolved first.

import type { DIContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { FANOUT_CONTEXTS } from './contexts';

export class FanoutInitializer {
  static registerProviders(container: DIContainer): void {
    for (const type of FANOUT_CONTEXTS) {
      container.registerAlias(DITokens.FANOUT_CONTEXTS, type);
    }
  }
}

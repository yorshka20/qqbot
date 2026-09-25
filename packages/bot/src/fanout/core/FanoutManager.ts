// FanoutManager — every fan-out by name, for triggers that carry only a name (the
// agenda `action fanout` item). Code that knows the class resolves it from DI instead.

import { singleton } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { FANOUT_CONTEXTS } from '../contexts';
import type { BaseFanout } from './BaseFanout';

@singleton()
export class FanoutManager {
  private readonly fanouts = new Map<string, BaseFanout<unknown>>();

  constructor() {
    // Each fan-out is a class-keyed singleton, so this lookup by name and a plugin
    // resolving the class reach the same instance, whichever is built first.
    for (const type of FANOUT_CONTEXTS) {
      // container-lookup: registry each fan-out class in FANOUT_CONTEXTS is a DI singleton
      const fanout = getContainer().resolve<BaseFanout<unknown>>(type);
      if (this.fanouts.has(fanout.name)) {
        throw new Error(`Fanout already registered: ${fanout.name}`);
      }
      this.fanouts.set(fanout.name, fanout);
    }
  }

  getByName(name: string): BaseFanout<unknown> | undefined {
    return this.fanouts.get(name);
  }
}

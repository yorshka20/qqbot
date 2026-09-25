// FanoutManager — every fan-out by name, for triggers that carry only a name (the
// agenda `action fanout` item). Code that knows the class resolves it from DI instead.

import { injectAll, singleton } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { BaseFanout } from './BaseFanout';

@singleton()
export class FanoutManager {
  private readonly fanouts = new Map<string, BaseFanout<unknown>>();

  constructor(@injectAll(DITokens.FANOUT_CONTEXTS) fanouts: BaseFanout<unknown>[]) {
    for (const fanout of fanouts) {
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

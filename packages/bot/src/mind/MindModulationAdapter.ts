/**
 * MindModulationAdapter — bridges `MindService` to the avatar package's
 * `MindModulationProvider` interface.
 *
 * Lives on the bot side so the avatar package stays pure (doesn't know
 * about MindService). The adapter's `getModulation` is on the
 * `enqueueTagAnimation` hot path, so it must not do any I/O — it just
 * reads the in-memory phenotype and projects it to modulation scalars.
 */

import type { MindModulation, MindModulationProvider, ModulationContext } from '@qqbot/avatar';
import { IDENTITY_MODULATION } from '@qqbot/avatar';
import type { MindService } from './MindService';
import { TONE_MAPPINGS } from './tone/mappings';

export class MindModulationAdapter implements MindModulationProvider {
  constructor(private readonly mind: MindService) {}

  getModulation(_ctx?: ModulationContext): MindModulation {
    if (!this.mind.isEnabled()) return IDENTITY_MODULATION;
    const { intensityScale, speedScale, durationBias } = this.mind.deriveModulation();
    const toneMapping = TONE_MAPPINGS[this.mind.getCurrentTone()];
    const { modulationDelta } = toneMapping;

    const combined: MindModulation = {
      amplitude: { intensityScale: intensityScale * modulationDelta.intensityScale },
      timing: {
        speedScale: speedScale * modulationDelta.speedScale,
        durationBias: (durationBias ?? 0) + modulationDelta.durationBias,
      },
    };
    if (modulationDelta.variantWeights) {
      combined.actionPref = { variantWeights: modulationDelta.variantWeights };
    }
    return combined;
  }
}

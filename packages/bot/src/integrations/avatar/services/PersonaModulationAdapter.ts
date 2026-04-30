/**
 * PersonaModulationAdapter — bridges `PersonaService` to the avatar package's
 * `MindModulationProvider` interface.
 *
 * Lives on the bot side so the avatar package stays pure (doesn't know
 * about PersonaService). The adapter's `getModulation` is on the
 * `enqueueTagAnimation` hot path, so it must not do any I/O — it just
 * reads the in-memory phenotype and projects it to modulation scalars.
 */

import type { MindModulation, MindModulationProvider, ModulationContext } from '@qqbot/avatar';
import { IDENTITY_MODULATION } from '@qqbot/avatar';
import type { PersonaService } from '@/persona/PersonaService';
import { TONE_MAPPINGS } from '@/persona/reflection/tone/mappings';

export class PersonaModulationAdapter implements MindModulationProvider {
  constructor(private readonly persona: PersonaService) {}

  getModulation(_ctx?: ModulationContext): MindModulation {
    if (!this.persona.isEnabled()) return IDENTITY_MODULATION;
    const { intensityScale, speedScale, durationBias } = this.persona.deriveModulation();
    const toneMapping = TONE_MAPPINGS[this.persona.getCurrentTone()];
    const { modulationDelta } = toneMapping;
    const cdna = this.persona.getCorePersona();

    const combined: MindModulation = {
      amplitude: { intensityScale: intensityScale * modulationDelta.intensityScale },
      timing: {
        speedScale: speedScale * modulationDelta.speedScale,
        durationBias: (durationBias ?? 0) + modulationDelta.durationBias,
      },
    };

    // actionPref: persona variantWeights baseline + tone overrides on key collision; persona forbiddenActions appended
    const personaWeights = cdna.modulation.actionPref.variantWeights;
    const toneWeights = modulationDelta.variantWeights ?? {};
    const merged: Record<string, readonly number[]> = { ...personaWeights, ...toneWeights };
    const hasMerged = Object.keys(merged).length > 0;
    const forbidden = cdna.modulation.actionPref.forbiddenActions;
    if (hasMerged || forbidden.length > 0) {
      combined.actionPref = {
        ...(hasMerged ? { variantWeights: merged } : {}),
        ...(forbidden.length > 0 ? { forbiddenActions: forbidden } : {}),
      };
    }

    // ambient: persona baseline × fatigue drop, always emit (small object)
    const fatigue = this.persona.getPhenotype().fatigue;
    const clampedFatigue = Math.max(0, Math.min(1, fatigue));
    const gain = cdna.modulation.ambient.gainScale * (1 - cdna.modulation.ambient.fatigueDrop * clampedFatigue);
    combined.ambient = { gainScale: Math.max(0, gain) };

    return combined;
  }
}

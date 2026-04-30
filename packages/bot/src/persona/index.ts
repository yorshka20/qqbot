// Mind Phase 2 — epigenetics persistence
export { EpigeneticsStore } from './reflection/epigenetics/EpigeneticsStore';
export type {
  PersonaEpigenetics,
  PersonaReflection,
  PersonaRelationship,
  ReflectionPatch,
  TraitHistoryEntry,
  TraitKey,
} from './reflection/epigenetics/types';
export { type PersonaComponents, PersonaInitializer } from './PersonaInitializer';
export { type PersonaLifecycleHandles, startPersonaSubsystem } from './PersonaLifecycle';
export { PersonaModulationAdapter } from '@/integrations/avatar/services/PersonaModulationAdapter';
export { PERSONA_EVENT_MESSAGE_RECEIVED, PersonaService, type PoseProvider } from './PersonaService';
export { applyStimulus, deriveModulation, derivePersonaPostureBias, freshPhenotype, tickPhenotype } from './ode';
export {
  buildPromptPatch,
  buildPromptPatchAsync,
  buildRelationshipSummary,
  DEFAULT_PROMPT_PATCH_THRESHOLDS,
  type PromptPatch,
  type PromptPatchThresholds,
  renderPromptPatchFragment,
} from './prompt/PromptPatchAssembler';
export { REFLECTION_SYSTEM_TEMPLATE_NAME, renderReflectionPrompt } from './reflection/prompt';
// Mind Phase 3 — reflection engine
export { ReflectionEngine } from './reflection/ReflectionEngine';
export type { ReflectionEngineOptions, ReflectionTrigger } from './reflection/types';
// Mind Phase 2 — relationship write path
export { classifyAffinityDelta, RelationshipUpdater } from './reflection/relationships/RelationshipUpdater';
// Mind Phase 3 — tone vocabulary
export { TONE_MAPPINGS } from './reflection/tone/mappings';
export { isTone, TONE_VOCABULARY, type Tone, type ToneMapping, type ToneModulationDelta } from './reflection/tone/types';
export {
  DEFAULT_PERSONA_CONFIG,
  type MessageStimulus,
  type PersonaConfig,
  type PersonaStateSnapshot,
  mergePersonaConfig,
  type PersonaId,
  type Phenotype,
  type Stimulus,
  type WanderConfig,
} from './types';
export { executeIntent, pickIntent } from '@/integrations/avatar/services/wander/intents';
export type { WanderExecutor, WanderIntent, WanderIntentKind, WanderStep } from '@/integrations/avatar/services/wander/types';
export { WanderScheduler, type WanderSchedulerOptions } from '@/integrations/avatar/services/wander/WanderScheduler';

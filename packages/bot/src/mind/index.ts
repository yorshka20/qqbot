// Mind Phase 2 — epigenetics persistence
export { EpigeneticsStore } from './epigenetics/EpigeneticsStore';
export type {
  PersonaEpigenetics,
  PersonaReflection,
  PersonaRelationship,
  ReflectionPatch,
  TraitHistoryEntry,
  TraitKey,
} from './epigenetics/types';
export { type MindComponents, MindInitializer } from './MindInitializer';
export { type MindLifecycleHandles, startMindSubsystem } from './MindLifecycle';
export { MindModulationAdapter } from './MindModulationAdapter';
export { MIND_EVENT_MESSAGE_RECEIVED, MindService, type PoseProvider } from './MindService';
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
export { classifyAffinityDelta, RelationshipUpdater } from './relationships/RelationshipUpdater';
// Mind Phase 3 — tone vocabulary
export { TONE_MAPPINGS } from './tone/mappings';
export { isTone, TONE_VOCABULARY, type Tone, type ToneMapping, type ToneModulationDelta } from './tone/types';
export {
  DEFAULT_MIND_CONFIG,
  type MessageStimulus,
  type MindConfig,
  type MindStateSnapshot,
  mergeMindConfig,
  type PersonaId,
  type Phenotype,
  type Stimulus,
  type WanderConfig,
} from './types';
export { executeIntent, pickIntent } from './wander/intents';
export type { WanderExecutor, WanderIntent, WanderIntentKind, WanderStep } from './wander/types';
export { WanderScheduler, type WanderSchedulerOptions } from './wander/WanderScheduler';

// Reflection prompt rendering — thin wrapper over PromptManager.

import type { PromptManager } from '@/ai/prompt/PromptManager';

/**
 * Template key for the reflection system prompt.
 * Maps to prompts/mind/zh/reflection-system.txt.
 * PromptManager key derivation: namespace = "mind.zh", file = "reflection-system" →
 * fullName = "mind.zh.reflection-system".
 */
export const REFLECTION_SYSTEM_TEMPLATE_NAME = 'mind.zh.reflection-system';

/** Variables passed to the reflection system template. */
export interface ReflectionPromptVars {
  personaId: string;
  phenotypeJson: string;
  epigeneticsJson: string;
  recentDialogue: string;
  trigger: string;
  /** Full raw markdown of CharacterBible.raw (or placeholder when bible empty). */
  characterBible: string;
}

/**
 * Render the reflection system prompt from template.
 * Throws if the template is missing (caught upstream so reflection is skipped).
 */
export function renderReflectionPrompt(promptManager: PromptManager, vars: ReflectionPromptVars): string {
  return promptManager.render(REFLECTION_SYSTEM_TEMPLATE_NAME, {
    personaId: vars.personaId,
    phenotypeJson: vars.phenotypeJson,
    epigeneticsJson: vars.epigeneticsJson,
    recentDialogue: vars.recentDialogue,
    trigger: vars.trigger,
    characterBible: vars.characterBible,
  });
}

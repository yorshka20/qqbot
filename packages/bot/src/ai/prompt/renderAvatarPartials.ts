// renderAvatarPartials — resolves the shared avatar prompt fragments that
// get composed into every avatar-related system prompt:
//
//   - persona          → `prompts/avatar/persona.txt`
//   - tagSpec          → `prompts/avatar/partials/tag-spec.txt`
//   - actions          → `prompts/avatar/partials/actions.txt`
//   - antiRepeat       → `prompts/avatar/partials/anti-repeat.txt`
//
// Two call sites consume this:
//   1. `Live2DPipeline`'s `PromptAssemblyStage` — for /avatar, bilibili
//      batches, and livemode runs (all three main avatar templates
//      reference every partial via `{{persona}}` / `{{tagSpec}}` etc.)
//   2. The main `MessagePipeline`'s `PromptAssemblyStage` — when it
//      injects `avatar.emotion-system` into a private-chat system prompt
//      so the avatar lip-syncs regular QQ replies. Same partials, same
//      persona — consistency is the whole point of the refactor.
//
// Any partial that fails to render (file missing, template error) is
// treated as empty. The main template references the variable with
// `{{name}}` and simply gets a blank there. This keeps the pipeline
// resilient to a deploy that forgets to ship one of the fragment files.

import { logger } from '@/utils/logger';
import type { PromptManager } from './PromptManager';

export interface AvatarPartials {
  persona: string;
  tagSpec: string;
  actions: string;
  antiRepeat: string;
}

/**
 * Template names. Kept as a constant so a future "per-source persona"
 * override (e.g. `avatar.persona.bilibili`) has a single place to branch.
 */
const PARTIAL_TEMPLATES = {
  persona: 'avatar.persona',
  tagSpec: 'avatar.partials.tag-spec',
  actions: 'avatar.partials.actions',
  antiRepeat: 'avatar.partials.anti-repeat',
} as const;

export function renderAvatarPartials(promptManager: PromptManager, availableActions: string): AvatarPartials {
  return {
    persona: safeRender(promptManager, PARTIAL_TEMPLATES.persona),
    tagSpec: safeRender(promptManager, PARTIAL_TEMPLATES.tagSpec),
    actions: safeRender(promptManager, PARTIAL_TEMPLATES.actions, { availableActions }),
    antiRepeat: safeRender(promptManager, PARTIAL_TEMPLATES.antiRepeat),
  };
}

function safeRender(promptManager: PromptManager, name: string, vars: Record<string, string> = {}): string {
  try {
    return promptManager.render(name, vars).trim();
  } catch (err) {
    logger.debug(`[renderAvatarPartials] partial "${name}" missing or failed to render (treated as empty):`, err);
    return '';
  }
}

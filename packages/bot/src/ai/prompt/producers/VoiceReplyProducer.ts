import type { PromptInjectionProducer } from '@/conversation/promptInjection/types';
import type { ResolvedVoiceReplyConfig } from '@/services/tts/voiceReplyConfig';
import type { PromptManager } from '../PromptManager';

/**
 * Voice-reply producer — renders `llm.tool.voice_reply`, the behavioral default
 * for the `speak` tool ("prefer voice for short, tone-carrying lines").
 *
 * The tool's own description states what it does; this states when to reach for
 * it over text, which is a delivery-contract question and belongs next to the
 * other tool instructions.
 *
 * `isAvailable` is the same predicate that gates the `speak` tool itself, so a
 * TTS backend going unhealthy removes the tool and this instruction together —
 * the prompt can never tell the model to speak when it can't.
 */
export function createVoiceReplyProducer(deps: {
  promptManager: PromptManager;
  limits: ResolvedVoiceReplyConfig;
  isAvailable: () => boolean;
}): PromptInjectionProducer {
  const { promptManager, limits, isAvailable } = deps;
  return {
    name: 'voice-reply',
    layer: 'tool',
    priority: 10,
    applicableSources: ['qq-private', 'qq-group'],
    produce() {
      if (!isAvailable()) return null;
      const fragment =
        promptManager.render('llm.tool.voice_reply', {
          maxTextLength: String(limits.maxTextLength),
          maxPerReply: String(limits.maxPerReply),
        }) ?? '';
      if (!fragment) return null;
      return { producerName: 'voice-reply', priority: 10, fragment };
    },
  };
}

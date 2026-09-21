import type { PromptInjectionProducer } from '@/conversation/promptInjection/types';
import { formatFaceVocabulary } from '@/message/qqFace';
import type { PromptManager } from '../PromptManager';

/**
 * QQ face producer — renders `llm.face_usage`, which teaches the `[表情:名字]` marker and
 * carries the name vocabulary the marker resolves against.
 *
 * Scoped to the QQ sources because the marker only expands on a protocol that has faces;
 * elsewhere it would reach the chat as literal text.
 *
 * The vocabulary is rendered once at registration: the face table is a static asset, so
 * re-joining ~380 names on every message would buy nothing.
 */
export function createFaceUsageProducer(deps: { promptManager: PromptManager }): PromptInjectionProducer {
  const fragment = deps.promptManager.render('llm.face_usage', { vocabulary: formatFaceVocabulary() }) ?? '';
  return {
    name: 'face-usage',
    layer: 'scene',
    priority: 20,
    applicableSources: ['qq-private', 'qq-group'],
    produce() {
      return fragment ? { producerName: 'face-usage', priority: 20, fragment } : null;
    },
  };
}

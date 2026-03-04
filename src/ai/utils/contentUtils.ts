// Shared utilities for ChatMessage content (string | ContentPart[])

import type { ChatMessage } from '../types';

/**
 * Flatten message content to plain string.
 * Multimodal parts (images) become placeholder "[Image]".
 * Use when a provider or caller only accepts string content (e.g. text-only APIs, prompt extraction).
 */
export function contentToPlainString(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => (part.type === 'text' ? part.text : '[Image]')).join('\n');
}

// Pure matching logic for onMessage agenda items, kept free of service state
// so the trigger semantics are unit-testable.

import { MessageUtils } from '@/message/MessageUtils';
import type { AgendaItem, AgendaSystemEvent } from './types';

export interface OnMessageMatch {
  matched: boolean;
  matchedKeyword?: string;
}

/** Parse an item's watchKeywords JSON into a clean string list ([] on malformed input). */
export function parseWatchKeywords(watchKeywords: string | undefined): string[] {
  if (!watchKeywords) return [];
  try {
    const parsed = JSON.parse(watchKeywords) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Decide whether a message-received event fires an onMessage item.
 * Rules:
 *   - bot's own messages never match (a reply containing a watched keyword
 *     must not re-trigger the item — that would loop)
 *   - group items match only their group; items without a group match only
 *     the creator's private chat
 *   - watchUserId (if set) must equal the sender
 *   - keywords (if any) match any-of, case-insensitive, against the
 *     user-authored text only (machine tokens like [Image:...] stripped)
 *   - an item with neither watchUserId nor keywords never matches
 */
export function matchOnMessageEvent(item: AgendaItem, keywords: string[], event: AgendaSystemEvent): OnMessageMatch {
  if (event.botSelfId && event.userId === event.botSelfId) return { matched: false };

  if (item.groupId) {
    if (event.groupId !== item.groupId) return { matched: false };
  } else {
    if (event.groupId) return { matched: false };
    if (event.userId !== item.userId) return { matched: false };
  }

  if (item.watchUserId && event.userId !== item.watchUserId) return { matched: false };

  if (!item.watchUserId && keywords.length === 0) return { matched: false };

  if (keywords.length > 0) {
    const rawText = typeof event.data?.text === 'string' ? event.data.text : '';
    const text = MessageUtils.extractUserText(rawText).toLowerCase();
    const matchedKeyword = keywords.find((k) => text.includes(k.toLowerCase()));
    if (!matchedKeyword) return { matched: false };
    return { matched: true, matchedKeyword };
  }

  return { matched: true };
}

// Message context storage - Map of currently processing message context by key.
// Pipeline registers context when starting and removes when done; async chain uses
// AsyncLocalStorage only for the current key so PromptManager can look up the right context.

import { AsyncLocalStorage } from 'async_hooks';
import type { NormalizedMessageEvent } from '@/events/types';

export interface MessageContextValue {
  message: NormalizedMessageEvent;
  /** Optional short tag for log lines (e.g. last 6 chars of messageId). Used to distinguish messages in pipeline debug. */
  logTag?: string;
  /** Optional ANSI background code for console (e.g. \\x1b[46m). Used for whole-line bg (first log) or prefix bg only (rest). No text/foreground color. */
  logColor?: string;
  /** When true, the next console log for this message uses whole-line background; logger then sets this to false so subsequent logs use prefix-only background. */
  logWholeLineBackground?: boolean;
}

/** Map: key (e.g. sessionId_messageId) -> context for that message. Cleared when processing finishes. */
const contextByKey = new Map<string, MessageContextValue>();

/** Async-local current key so we know which Map entry belongs to this async chain. */
const currentKeyStorage = new AsyncLocalStorage<string>();

/**
 * Run the pipeline body with this message's context registered in the Map.
 * The key is set in async local storage so any code in the chain can resolve context via getCurrentMessageContext().
 * When fn completes (or throws), the entry is removed from the Map.
 */
export async function enterMessageContext<T>(
  key: string,
  context: MessageContextValue,
  fn: () => Promise<T>,
): Promise<T> {
  contextByKey.set(key, context);
  try {
    return await currentKeyStorage.run(key, fn);
  } finally {
    contextByKey.delete(key);
  }
}

/**
 * Get the message context for the current async chain (used by PromptManager when rendering base system prompt).
 * Returns the value from the Map for the key stored in async local storage.
 */
export function getCurrentMessageContext(): MessageContextValue | undefined {
  const key = currentKeyStorage.getStore();
  return key !== undefined ? contextByKey.get(key) : undefined;
}

import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';

export type MessageSource =
  | 'qq-private'
  | 'qq-group'
  | 'discord'
  | 'avatar-cmd'
  | 'bilibili-danmaku'
  | 'idle-trigger'
  | 'bootstrap';

export const SOURCE_VALUES: readonly MessageSource[] = [
  'qq-private',
  'qq-group',
  'discord',
  'avatar-cmd',
  'bilibili-danmaku',
  'idle-trigger',
  'bootstrap',
] as const;

/**
 * Derive MessageSource from a NormalizedMessageEvent. Used as fallback
 * when callers of MessagePipeline.process don't pass an explicit source.
 *
 * Mapping:
 *   - protocol === 'discord'                     → 'discord' (regardless of messageType)
 *   - messageType === 'private' (non-discord)    → 'qq-private'
 *   - messageType === 'group'   (non-discord)    → 'qq-group'
 *   - anything else                              → 'qq-private' (warn)
 */
export function deriveSourceFromEvent(event: NormalizedMessageEvent): MessageSource {
  if (event.protocol === 'discord') return 'discord';
  if (event.messageType === 'private') return 'qq-private';
  if (event.messageType === 'group') return 'qq-group';
  logger.warn(
    `[deriveSourceFromEvent] unrecognized event shape; falling back to qq-private | protocol=${event.protocol} messageType=${event.messageType}`,
  );
  return 'qq-private';
}
